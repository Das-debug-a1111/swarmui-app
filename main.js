const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path    = require('path');
const fs      = require('fs').promises;
const fsSync  = require('fs');
const crypto  = require('crypto');
const zlib    = require('zlib');

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
ipcMain.handle('config:get', () => ({ dataPath: DATA_PATH }));

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

  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
});

autoUpdater.on('update-available', (info) => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('update-available', info.version);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
