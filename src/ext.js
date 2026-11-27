// Accroches pour des extensions locales : un dossier private/ (hors du dépôt) peut remplacer des scripts, en ajouter,
// déclarer des onglets et s'intercaler à quelques moments. Sans ce dossier, tout reste tel quel.
// document.write garde l'ordre de chargement des scripts classiques ; seuls des chemins fixes du disque y passent.
const Ext = {
  replace: {},            // 'src/x.js' → chemin du script qui le remplace
  extra: [],              // scripts chargés avant app.js
  tabs: {},               // nom d'onglet → { onShow(), onHide() } ; la vue est #view-<nom>
  firstTab: null,
  saver: null,            // { active(), save(source, onglet, suffixe, contexte) } : enregistre une image ailleurs qu'en téléchargement
  beforeGeneration: [],   // fonctions attendues avant chaque génération d'image
  async ready() { for (const hook of this.beforeGeneration) await hook(); },
  tag(path) { document.write(`<script src="${this.replace[path] || path}"><\/script>`); },
  scripts() { this.extra.forEach(p => this.tag(p)); },
};
