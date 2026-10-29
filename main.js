const { app, BrowserWindow, ipcMain, shell, dialog, net, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path    = require('path');
const fs      = require('fs').promises;
const fsSync  = require('fs');
const crypto  = require('crypto');
const zlib    = require('zlib');
const { spawn } = require('child_process');

// Un terminal fermé rend stdout/stderr inutilisables (EIO/EPIPE) : ne pas planter l'app pour un simple log
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// ── Config (persisted in userData) ───────────────────────────────────────────
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try { return JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  fsSync.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config   = loadConfig();

// Bundled data path (extraResources → next to app in Resources/data)
const BUNDLED_DATA_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'data')
  : path.join(__dirname, 'assets', 'data');

let DATA_PATH = config.dataPath || BUNDLED_DATA_PATH;

// ── In-memory cache ───────────────────────────────────────────────────────────
let _charList   = null;
let _charThumbs = null;
let _tagAssist  = null;

function invalidateCache() {
  _charList = _charThumbs = _tagAssist = null;
}

// ── IPC: config ───────────────────────────────────────────────────────────────
ipcMain.handle('config:get', () => ({
  dataPath:          DATA_PATH,
  swarmLaunchScript: config.swarmLaunchScript || null,
  forgeLaunchScript: config.forgeLaunchScript || null,
  forgeLaunchArgs:   config.forgeLaunchArgs   || '',
}));

// Small allowlist, not a fully generic setter — keeps the IPC surface
// intentional even though this renderer is fully trusted (no remote content).
const SETTABLE_CONFIG_KEYS = new Set(['forgeLaunchArgs']);
ipcMain.handle('config:set', (_, key, value) => {
  if (!SETTABLE_CONFIG_KEYS.has(key)) return { error: 'not_settable' };
  config[key] = value;
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('config:pickDataFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title:      'Select character data folder',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths.length) return null;

  const chosen = filePaths[0];
  // Quick sanity check — look for the CSV
  const csvPath = path.join(chosen, 'wai_characters.csv');
  try {
    await fs.access(csvPath);
  } catch {
    return { error: 'wai_characters.csv not found in this folder.' };
  }

  DATA_PATH = chosen;
  config.dataPath = chosen;
  saveConfig(config);
  invalidateCache();
  return { path: chosen };
});

// ── IPC: character list ───────────────────────────────────────────────────────
ipcMain.handle('char:list', async () => {
  if (!DATA_PATH) return { error: 'no_data_path' };
  try {
    if (_charList) return _charList;
    const csv = await fs.readFile(path.join(DATA_PATH, 'wai_characters.csv'), 'utf8');
    _charList = csv.split('\n')
      .map(l => l.trim()).filter(Boolean)
      .map(l => {
        const name = l.split(',')[1]?.trim();
        if (!name) return null;
        const m = name.match(/\(([^)]+)\)\s*$/);
        const series = m ? m[1] : '';
        return { name, series };
      }).filter(Boolean);
    return _charList;
  } catch (e) { return { error: e.message }; }
});

// ── IPC: character thumbnail ──────────────────────────────────────────────────
ipcMain.handle('char:thumb', async (_, name) => {
  if (!DATA_PATH) return null;
  try {
    if (!_charThumbs) {
      const raw = await fs.readFile(path.join(DATA_PATH, 'wai_character_thumbs.json'), 'utf8');
      _charThumbs = JSON.parse(raw);
    }
    const sanitized = name.replaceAll('(', String.raw`\(`).replaceAll(')', String.raw`\)`);
    const hash      = crypto.createHash('md5').update(sanitized).digest('hex');
    const gzipB64   = _charThumbs[hash];
    if (!gzipB64) return null;
    const decompressed = zlib.gunzipSync(Buffer.from(gzipB64, 'base64'));
    return `data:image/webp;base64,${decompressed.toString('base64')}`;
  } catch { return null; }
});

// ── IPC: tag assist ───────────────────────────────────────────────────────────
ipcMain.handle('char:tags', async () => {
  if (!DATA_PATH) return null;
  try {
    if (_tagAssist) return _tagAssist;
    const raw = await fs.readFile(path.join(DATA_PATH, 'wai_tag_assist.json'), 'utf8');
    _tagAssist = JSON.parse(raw);
    return _tagAssist;
  } catch { return null; }
});

// ── IPC: thumbs loaded? ───────────────────────────────────────────────────────
ipcMain.handle('char:thumbsReady', () => _charThumbs !== null);

// ── IPC: model download ───────────────────────────────────────────────────────

// Pick the ComfyUI "models" folder
ipcMain.handle('models:pickFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title:      'Select your ComfyUI models folder',
    message:    'Navigate to the "models" folder inside your ComfyUI installation',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

// Download a file from URL → destPath, sending progress events back
// The renderer builds destPath from the Civitai API's file name: never let it write outside a
// model folder or create anything but a model file (e.g. overwrite ~/.zshrc via "../").
const MODEL_FILE_EXT = new Set(['.safetensors', '.sft', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx', '.zip']);
function checkDownload(url, destPath) {
  let u;
  try { u = new URL(url); } catch { return 'URL invalide'; }
  if (u.protocol !== 'https:') return 'Seuls les téléchargements https sont autorisés';
  if (typeof destPath !== 'string' || !path.isAbsolute(destPath)) return 'Chemin de destination invalide';
  if (destPath.split(/[\\/]/).includes('..')) return 'Chemin de destination invalide (..)';
  if (!MODEL_FILE_EXT.has(path.extname(destPath).toLowerCase())) return `Type de fichier refusé : ${path.extname(destPath) || '(aucune extension)'}`;
  return null;
}

ipcMain.handle('models:download', async (event, { url, destPath }) => {
  const invalid = checkDownload(url, destPath);
  if (invalid) throw new Error(invalid);
  // Ensure directory exists
  fsSync.mkdirSync(path.dirname(destPath), { recursive: true });

  const tmpPath = destPath + '.tmp';

  // Clean up any stale tmp file
  try { fsSync.unlinkSync(tmpPath); } catch {}

  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Server returned ${res.statusCode} for ${url}`));
        return;
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      const file = fsSync.createWriteStream(tmpPath);
      // Disk full / permission denied: fail the download instead of leaving the promise hanging
      file.on('error', (err) => {
        try { req.abort(); } catch {}
        try { fsSync.unlinkSync(tmpPath); } catch {}
        reject(err);
      });

      res.on('data', (chunk) => {
        file.write(chunk);
        downloadedBytes += chunk.length;
        const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : -1;
        // Send progress to renderer
        try {
          event.sender.send('models:progress', { destPath, downloadedBytes, totalBytes, pct });
        } catch {}
      });

      res.on('end', () => {
        file.end(() => {
          try {
            fsSync.renameSync(tmpPath, destPath);
            resolve(destPath);
          } catch (err) { reject(err); }
        });
      });

      res.on('error', (err) => {
        file.destroy();
        try { fsSync.unlinkSync(tmpPath); } catch {}
        reject(err);
      });
    });

    req.on('error', (err) => {
      try { fsSync.unlinkSync(tmpPath); } catch {}
      reject(err);
    });

    req.end();
  });
});

// ── IPC: process launcher (SwarmUI, Forge, …) ─────────────────────────────────
// `key` selects which config.json field holds the script path (e.g. 'swarmLaunchScript',
// 'forgeLaunchScript') and doubles as the running-process registry key.
const launchedProcesses = {};

// Only these config entries hold launch scripts; anything else would let the renderer
// overwrite / execute arbitrary config values.
const LAUNCH_KEYS = new Set(['swarmLaunchScript', 'forgeLaunchScript']);
// The command line goes through a shell (shell:true), so each arg must be a plain token:
// no & | ; < > $ ` " ' ( ) or newlines that would chain another command.
const SAFE_ARG = /^[A-Za-z0-9_@+=:,.\/\\-]+$/;

ipcMain.handle('launcher:pickScript', async (_, key, dialogTitle, dialogMessage) => {
  if (!LAUNCH_KEYS.has(key)) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title:       dialogTitle,
    message:     dialogMessage,
    properties:  ['openFile'],
    filters:     [{ name: 'Launch script', extensions: ['bat', 'cmd', 'sh', 'command'] }],
  });
  if (canceled || !filePaths.length) return null;

  config[key] = filePaths[0];
  saveConfig(config);
  return filePaths[0];
});

ipcMain.handle('launcher:launch', (_, key, args = []) => {
  if (!LAUNCH_KEYS.has(key)) return { error: 'unknown_launcher' };
  if (!Array.isArray(args)) args = [];
  const badArg = args.find(a => typeof a !== 'string' || !SAFE_ARG.test(a));
  if (badArg !== undefined) return { error: `Argument refusé (caractères spéciaux) : ${String(badArg).slice(0, 40)}` };
  const running = launchedProcesses[key];
  if (running && running.exitCode === null) return { ok: true, alreadyRunning: true };

  const scriptPath = config[key];
  if (!scriptPath) return { error: 'no_script_configured' };
  if (!fsSync.existsSync(scriptPath)) {
    delete config[key];
    saveConfig(config);
    return { error: 'script_not_found' };
  }

  try {
    // Run by basename with cwd set to its folder — spawning the full path via
    // shell:true breaks silently on Windows when the folder name has spaces
    // (cmd.exe splits the unquoted path into separate tokens).
    // NoDefaultCurrentDirectoryInExePath (set system-wide here) blocks cmd.exe's
    // implicit cwd search for bare filenames — including inside the launched
    // script's own `call other.bat` lines — so strip it for this child only.
    const env = { ...process.env };
    delete env.NoDefaultCurrentDirectoryInExePath;

    // Build one command string ourselves — passing `args` alongside shell:true
    // makes Node concatenate them unescaped and emit a deprecation warning.
    // cmd.exe searches cwd for a bare filename by default (Windows); POSIX
    // shells don't, so a bare basename would fail with "command not found"
    // on macOS/Linux — prefix with ./ there.
    const base = (process.platform === 'win32' ? '' : './') + path.basename(scriptPath);
    const quotedArgs = args.join(' ');
    const commandLine = quotedArgs ? `${base} ${quotedArgs}` : base;

    const proc = spawn(commandLine, [], {
      cwd:      path.dirname(scriptPath),
      shell:    true,
      detached: true,
      stdio:    'ignore',
      env,
    });
    proc.unref();
    proc.on('exit', () => { launchedProcesses[key] = null; });
    launchedProcesses[key] = proc;
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0d1117',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  // A grey/blank window means the renderer process died (usually out of memory). Log why, and
  // reload by itself instead of leaving the user staring at nothing — the Comic tab restores its
  // pages from its autosave on reload. Capped so a crash loop at startup can't spin forever.
  const crashLog = path.join(app.getPath('userData'), 'crash.log');
  const logCrash = msg => { try { fsSync.appendFileSync(crashLog, `[${new Date().toISOString()}] ${msg}\n`); } catch {} };
  let recentReloads = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    logCrash(`renderer gone: reason=${details.reason} exitCode=${details.exitCode}`);
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    recentReloads = recentReloads.filter(t => now - t < 60000);
    if (recentReloads.length >= 3 || win.isDestroyed()) return;
    recentReloads.push(now);
    setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 400);
  });
  win.webContents.on('unresponsive', () => logCrash('renderer unresponsive'));
  win.webContents.on('responsive',   () => logCrash('renderer responsive again'));

  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Dropping an image/file outside a drop zone made Chromium navigate the whole window to it
  // (the app "disappeared" until reload). The app is a single page: block every navigation.
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

// ── IPC: LLM local (Ollama) ───────────────────────────────────────────────────
function llmBaseUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch { return null; }
}

function llmNetError(e, base) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'Délai dépassé : Ollama n\'a pas répondu à temps.';
  return `Ollama ne répond pas à ${base} — est-il lancé ?`;
}

function llmCleanText(raw) {
  let t = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/<\/think>/gi, '').trim();
  const fence = t.match(/^```[a-z]*\n?([\s\S]*?)\n?```$/i);
  if (fence) t = fence[1].trim();
  const pairs = [['"', '"'], ['\u201C', '\u201D'], ['\u00AB', '\u00BB']];
  for (const [a, b] of pairs) {
    if (t.length > 1 && t.startsWith(a) && t.endsWith(b) && !t.slice(1, -1).includes(a)) { t = t.slice(1, -1).trim(); break; }
  }
  return t;
}

ipcMain.handle('llm:generate', async (_, opts) => {
  try {
    const { url, model, system, prompt, temperature, unload, history, numCtx } = opts || {};
    const base = llmBaseUrl(url);
    if (!base) return { error: 'URL d\'Ollama invalide.' };
    if (typeof model !== 'string' || !model.trim() || model.length > 200) return { error: 'Nom de modèle invalide.' };
    if (typeof system !== 'string' || !system.trim() || system.length > 20000) return { error: 'Prompt système (avec les exemples) vide ou trop long (max 20000 caractères).' };
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) return { error: 'Idée invalide (vide ou trop longue).' };
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) return { error: 'Température invalide (0 à 2).' };

    const past = [];
    if (history !== undefined) {
      if (!Array.isArray(history) || history.length > 40) return { error: 'Historique de conversation invalide (40 messages max).' };
      let total = 0;
      for (const m of history) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 8000) {
          return { error: 'Historique de conversation invalide.' };
        }
        total += m.content.length;
        past.push({ role: m.role, content: m.content });
      }
      if (total > 60000) return { error: 'Historique de conversation trop long.' };
    }
    const options = { temperature };
    if (numCtx !== undefined) {
      if (!Number.isInteger(numCtx) || numCtx < 2048 || numCtx > 32768) return { error: 'Taille de contexte invalide (2048 à 32768).' };
      options.num_ctx = numCtx;
    }

    const body = {
      model: model.trim(),
      messages: [{ role: 'system', content: system }, ...past, { role: 'user', content: prompt }],
      stream: false,
      think: false,
      keep_alive: unload ? 0 : '5m',
      options,
    };
    const post = () => fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    let res;
    try { res = await post(); } catch (e) { return { error: llmNetError(e, base) }; }
    let data = await res.json().catch(() => null);
    if (res.status === 400 && /think/i.test(data?.error || '')) {
      delete body.think;
      try { res = await post(); } catch (e) { return { error: llmNetError(e, base) }; }
      data = await res.json().catch(() => null);
    }
    if (!res.ok) return { error: data?.error || `Ollama a répondu HTTP ${res.status}.` };
    const text = llmCleanText(data?.message?.content);
    if (!text) return { error: 'Réponse vide du modèle.' };
    return { ok: true, text };
  } catch (e) {
    return { error: 'Erreur inattendue : ' + (e?.message || e) };
  }
});

ipcMain.handle('llm:models', async (_, url) => {
  try {
    const base = llmBaseUrl(url);
    if (!base) return { error: 'URL d\'Ollama invalide.' };
    let res;
    try { res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10000) }); }
    catch (e) { return { error: llmNetError(e, base) }; }
    if (!res.ok) return { error: `Ollama a répondu HTTP ${res.status}.` };
    const data = await res.json().catch(() => null);
    const models = (data?.models || []).map(m => m?.name).filter(n => typeof n === 'string');
    return { ok: true, models };
  } catch (e) {
    return { error: 'Erreur inattendue : ' + (e?.message || e) };
  }
});

// ── IPC: auto-update ──────────────────────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

ipcMain.handle('app:installUpdate', () => {
  autoUpdater.quitAndInstall();
});

function sendToWindow(channel, ...args) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send(channel, ...args);
}

autoUpdater.on('update-available',   (info)     => sendToWindow('update-available', info.version));
autoUpdater.on('download-progress',  (progress) => sendToWindow('update-download-progress', Math.round(progress.percent)));
autoUpdater.on('update-downloaded',  (info)     => sendToWindow('update-downloaded', info.version));
autoUpdater.on('error',              (err)      => sendToWindow('update-error', err.message));

app.whenReady().then(() => {
  // 'local-fonts' is for the Comic tab's font picker (queryLocalFonts);
  // clipboard permissions are for the copy-to-clipboard buttons used across
  // every tab's gallery/lightbox.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['local-fonts', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  createWindow();
  if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
});

app.on('child-process-gone', (_e, details) => {
  try { fsSync.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), `[${new Date().toISOString()}] ${details.type} process gone: reason=${details.reason}\n`); } catch {}
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
