'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cartellaTemporanea } = require('./helpers');

// Il percorso delle credenziali si fissa al caricamento del modulo: la cartella
// va scelta prima del require. Ogni file di test gira in un processo a se'.
const dir = cartellaTemporanea('config');
process.env.SOLCO_CONFIG_DIR = path.join(dir, 'utente');
delete process.env.SOLCO_OPENROUTER_KEY;
const { createAiConfigStore, SECRETS_FILE } = require('../ai-config');

const impostazioni = path.join(dir, 'ai-config.json');
const store = createAiConfigStore(impostazioni);
const leggi = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('ai-config', () => {
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('senza file parte da LM Studio e nessuna chiave', () => {
    assert.deepEqual(store.load(), { provider: 'lmstudio', openRouterModel: '', openRouterKey: '', keyFromEnv: false });
    assert.equal(SECRETS_FILE, path.join(dir, 'utente', 'credentials.json'));
  });

  it('migra una chiave delle versioni vecchie fuori da ai-config.json', () => {
    fs.writeFileSync(impostazioni, JSON.stringify({ provider: 'openrouter', openRouterModel: 'm', openRouterKey: 'vecchia' }));
    assert.equal(store.load().openRouterKey, 'vecchia', 'leggibile anche prima della migrazione');
    assert.equal(store.migrate().moved, true);
    assert.equal(leggi(SECRETS_FILE).openRouterKey, 'vecchia');
    assert.deepEqual(leggi(impostazioni), { provider: 'openrouter', openRouterModel: 'm' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(SECRETS_FILE).mode & 0o777, 0o600);
    assert.equal(store.migrate().moved, false, 'la seconda volta non c\'e\' nulla da spostare');
  });

  it('una chiave nuova sostituisce la vecchia, una vuota la lascia', () => {
    store.save({ provider: 'openrouter', openRouterModel: 'm2', openRouterKey: ' nuova ' });
    assert.equal(leggi(SECRETS_FILE).openRouterKey, 'nuova');
    const dopo = store.save({ provider: 'openrouter', openRouterModel: 'm3', openRouterKey: '' });
    assert.equal(dopo.openRouterKey, 'nuova');
    assert.equal(dopo.openRouterModel, 'm3');
    assert.ok(!fs.readFileSync(impostazioni, 'utf8').includes('nuova'));
  });

  it('un provider sconosciuto torna a LM Studio', () => {
    assert.equal(store.save({ provider: 'altro' }).provider, 'lmstudio');
  });

  it('la chiave della variabile d\'ambiente vince e non finisce mai su disco', () => {
    process.env.SOLCO_OPENROUTER_KEY = 'da-ambiente';
    try {
      const cfg = store.load();
      assert.equal(cfg.openRouterKey, 'da-ambiente');
      assert.equal(cfg.keyFromEnv, true);
      store.save({ provider: 'openrouter', openRouterModel: 'm' });
      assert.equal(leggi(SECRETS_FILE).openRouterKey, 'nuova');
    } finally {
      delete process.env.SOLCO_OPENROUTER_KEY;
    }
  });
});
