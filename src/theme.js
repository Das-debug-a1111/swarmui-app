// ── Thème de l'interface ──────────────────────────────────────────────────────
// Chargé dans <head> pour appliquer le thème avant le premier rendu (pas de flash).
// Les variables et règles sont dans styles/themes.css ; '' = look d'origine.
const Theme = (() => {
  const KEY = 'swarm-theme';
  const FONTS = {
    atelier: 'family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600',
    minimal: 'family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;600',
    neon:    'family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600',
  };

  function read() {
    try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
  }

  // Polices chargées seulement pour le thème actif (rien pour le look d'origine)
  function loadFonts(name) {
    document.getElementById('theme-fonts')?.remove();
    if (!FONTS[name]) return;
    const link = document.createElement('link');
    link.id = 'theme-fonts';
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?${FONTS[name]}&display=swap`;
    document.head.appendChild(link);
  }

  function apply(name) {
    if (name && FONTS[name]) document.documentElement.dataset.theme = name;
    else { delete document.documentElement.dataset.theme; name = ''; }
    loadFonts(name);
    try { localStorage.setItem(KEY, name); } catch {}
  }

  apply(read());

  document.addEventListener('DOMContentLoaded', () => {
    const sel = document.getElementById('sel-theme');
    if (!sel) return;
    sel.value = read();
    sel.addEventListener('change', () => apply(sel.value));
  });

  return { apply };
})();
