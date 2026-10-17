'use strict';

// Configurazione IA. Le impostazioni non riservate (provider e modello) restano in
// ai-config.json nella cartella dell'app; la chiave OpenRouter vive invece nella
// cartella di configurazione dell'utente, con permessi 0600, cosi' non finisce in
// uno zip, in un repository o in una copia della cartella.

const fs = require('fs');
const os = require('os');
const path = require('path');

function userConfigDir() {
  if (process.env.SOLCO_CONFIG_DIR) return process.env.SOLCO_CONFIG_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Solco');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Solco');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'solco');
}

const SECRETS_FILE = path.join(userConfigDir(), 'credentials.json');

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

function envKey() {
  return String(process.env.SOLCO_OPENROUTER_KEY || '').trim();
}

function readStoredKey() {
  const secrets = readJson(SECRETS_FILE);
  return secrets ? String(secrets.openRouterKey || '') : '';
}

function writeStoredKey(key) {
  const dir = path.dirname(SECRETS_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Scrittura su file temporaneo e rinomina: un'interruzione non lascia mai
  // credentials.json troncato o vuoto.
  const tmp = SECRETS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ openRouterKey: String(key || '') }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
  try {
    fs.chmodSync(SECRETS_FILE, 0o600);
  } catch (e) {}
}

function createAiConfigStore(settingsFile) {
  function loadSettings() {
    const parsed = readJson(settingsFile) || {};
    return {
      provider: parsed.provider === 'openrouter' ? 'openrouter' : 'lmstudio',
      openRouterModel: String(parsed.openRouterModel || ''),
      legacyKey: String(parsed.openRouterKey || '')
    };
  }

  function load() {
    const settings = loadSettings();
    const fromEnv = envKey();
    // Ordine: variabile d'ambiente, file nella cartella utente, e infine la vecchia
    // posizione dentro ai-config.json, che resta leggibile se la migrazione fallisce.
    const openRouterKey = fromEnv || readStoredKey() || settings.legacyKey;
    return {
      provider: settings.provider,
      openRouterModel: settings.openRouterModel,
      openRouterKey,
      keyFromEnv: !!fromEnv
    };
  }

  // Una chiave assente (null o vuota) lascia com'e' quella salvata. Prima si
  // riscriveva la chiave in uso, e se veniva da SOLCO_OPENROUTER_KEY finiva
  // copiata su disco al primo salvataggio delle impostazioni.
  function save(cfg) {
    const provider = cfg.provider === 'openrouter' ? 'openrouter' : 'lmstudio';
    const openRouterModel = String(cfg.openRouterModel || '');
    const nuova = String(cfg.openRouterKey || '').trim();
    // la vecchia chiave dentro ai-config.json sparisce con la riscrittura qui
    // sotto: se la migrazione non l'ha ancora spostata, la si mette al sicuro
    const legacy = loadSettings().legacyKey;
    if (nuova) writeStoredKey(nuova);
    else if (legacy && !readStoredKey()) writeStoredKey(legacy);
    fs.writeFileSync(settingsFile, JSON.stringify({ provider, openRouterModel }, null, 2) + '\n');
    return load();
  }

  // Sposta una chiave rimasta in ai-config.json e la cancella da li'. Chiamata
  // all'avvio: e' un'operazione sola, non serve ripeterla a ogni lettura.
  function migrate() {
    const settings = loadSettings();
    if (!settings.legacyKey) return { moved: false, file: SECRETS_FILE };
    if (!readStoredKey()) writeStoredKey(settings.legacyKey);
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ provider: settings.provider, openRouterModel: settings.openRouterModel }, null, 2) + '\n'
    );
    return { moved: true, file: SECRETS_FILE };
  }

  return { load, save, migrate, secretsFile: SECRETS_FILE };
}

module.exports = { createAiConfigStore, userConfigDir, SECRETS_FILE };
