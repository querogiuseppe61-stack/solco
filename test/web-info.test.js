'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cartellaTemporanea } = require('./helpers');
const { createWebInfoService, normalize, extractJson, escapeLucene, relevantWikipediaPage } = require('../web-info');

describe('funzioni di supporto', () => {
  it('normalize toglie accenti, maiuscole e punteggiatura', () => {
    assert.equal(normalize('  Café Tacvba!  '), 'cafe tacvba');
    assert.equal(normalize('AC/DC'), 'ac dc');
    assert.equal(normalize(null), '');
  });

  it('extractJson trova il primo oggetto anche fra recinti e chiacchiere', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('Ecco: {"a":{"b":[1,2]}} spero vada bene {"c":3}'), { a: { b: [1, 2] } });
    assert.equal(extractJson('nessun oggetto'), null);
    assert.equal(extractJson('{"a":'), null);
    assert.equal(extractJson('{a: 1}'), null);
  });

  it('escapeLucene protegge i caratteri speciali della ricerca MusicBrainz', () => {
    assert.equal(escapeLucene('AC/DC: "Live"'), 'AC\\/DC\\: \\"Live\\"');
    assert.equal(escapeLucene('(What\'s the Story)?'), '\\(What\'s the Story\\)\\?');
  });

  it('relevantWikipediaPage scarta le pagine che non c\'entrano', () => {
    const pagine = [{ title: 'Pink Floyd' }, { title: 'The Wall (album)' }];
    assert.equal(relevantWikipediaPage('The Wall Pink Floyd', pagine).title, 'Pink Floyd');
    assert.equal(relevantWikipediaPage('Radiohead', pagine), null);
    // per gli artisti il titolo deve coincidere o cominciare con il nome
    assert.equal(relevantWikipediaPage('Floyd', pagine, true), null);
    assert.equal(relevantWikipediaPage('Pink', pagine, true).title, 'Pink Floyd');
    assert.equal(relevantWikipediaPage('pink floyd', pagine, true).title, 'Pink Floyd');
  });
});

// fetch finto: ogni regola e' [pezzo di URL, funzione che restituisce { status, body }]
function fetchFinto(regole) {
  const chiamate = [];
  const fn = async (url, init) => {
    chiamate.push({ url: String(url), init });
    const regola = regole.find(([pezzo]) => String(url).includes(pezzo));
    if (!regola) throw new Error('rete non raggiungibile: ' + url);
    const { status, body } = regola[1](String(url), init);
    return new Response(JSON.stringify(body), { status: status || 200 });
  };
  fn.chiamate = chiamate;
  return fn;
}

describe('createWebInfoService', () => {
  const fetchVero = global.fetch;
  let dir;
  let cacheFile;
  let config;
  const servizio = () => createWebInfoService({
    cacheFile,
    loadAiConfig: () => config,
    lmStudioBase: 'http://lmstudio.finto/v1'
  });

  beforeEach(() => {
    dir = cartellaTemporanea('web');
    cacheFile = path.join(dir, 'web-cache.json');
    config = { provider: 'lmstudio', openRouterKey: '', openRouterModel: '' };
  });
  afterEach(() => {
    global.fetch = fetchVero;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('LM Studio spento: IA non disponibile', async () => {
    global.fetch = fetchFinto([]);
    const stato = await servizio().aiStatus();
    assert.equal(stato.available, false);
    assert.equal(stato.provider, 'LM Studio');
  });

  it('LM Studio sceglie un modello testuale, non quelli di embedding', async () => {
    global.fetch = fetchFinto([['/models', () => ({ body: { data: [{ id: 'nomic-embed' }, { id: 'phi-3' }, { id: 'qwen2.5-7b' }] } })]]);
    const stato = await servizio().aiStatus();
    assert.equal(stato.available, true);
    assert.equal(stato.model, 'qwen2.5-7b');
  });

  it('OpenRouter: lo stato dipende solo dalla configurazione, senza rete', async () => {
    global.fetch = fetchFinto([]);
    config = { provider: 'openrouter', openRouterKey: '', openRouterModel: 'm' };
    assert.match((await servizio().aiStatus()).message, /chiave/);
    config = { provider: 'openrouter', openRouterKey: 'k', openRouterModel: '' };
    assert.match((await servizio().aiStatus()).message, /modello/);
    config = { provider: 'openrouter', openRouterKey: 'k', openRouterModel: 'm' };
    assert.equal((await servizio().aiStatus()).available, true);
    assert.equal(global.fetch.chiamate.length, 0);
  });

  it('chatJSON manda la chiave a OpenRouter e interpreta la risposta', async () => {
    config = { provider: 'openrouter', openRouterKey: 'sk-1', openRouterModel: 'modello/x' };
    global.fetch = fetchFinto([['/chat/completions', (url, init) => {
      const corpo = JSON.parse(init.body);
      assert.equal(init.headers.Authorization, 'Bearer sk-1');
      assert.equal(corpo.model, 'modello/x');
      return { body: { choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] } };
    }]]);
    const r = await servizio().chatJSON('sistema', 'utente');
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { ok: true });
    assert.ok(global.fetch.chiamate[0].url.startsWith('https://openrouter.ai/api/v1/'));
  });

  it('chatJSON segnala una risposta che non e\' JSON o un errore del provider', async () => {
    config = { provider: 'openrouter', openRouterKey: 'sk-1', openRouterModel: 'm' };
    global.fetch = fetchFinto([['/chat/completions', () => ({ body: { choices: [{ message: { content: 'boh' } }] } })]]);
    assert.match((await servizio().chatJSON('s', 'u')).reason, /JSON/);
    global.fetch = fetchFinto([['/chat/completions', () => ({ status: 401, body: { error: { message: 'chiave scaduta' } } })]]);
    const r = await servizio().chatJSON('s', 'u');
    assert.equal(r.ok, false);
    assert.match(r.reason, /401.*chiave scaduta/);
  });

  it('una scheda album riuscita resta in cache e non rifa le richieste', async () => {
    global.fetch = fetchFinto([
      ['musicbrainz.org/ws/2/release-group?query', () => ({ body: { 'release-groups': [] } })],
      ['/w/rest.php/v1/search/page', () => ({ body: { pages: [] } })]
    ]);
    const web = servizio();
    const album = { artist: 'Nessuno', title: 'Inesistente', year: 2001, genre: [] };
    const prima = await web.albumInfo(album, false);
    assert.equal(prima.match.disambiguation, 'Nessuna corrispondenza certa su MusicBrainz');
    const chiamate = global.fetch.chiamate.length;
    const seconda = await web.albumInfo(album, false);
    assert.deepEqual(seconda, prima);
    assert.equal(global.fetch.chiamate.length, chiamate);
    assert.ok(fs.existsSync(cacheFile));
    assert.ok(!fs.existsSync(cacheFile + '.tmp'));
  });

  it('una sintesi IA fallita non finisce in cache', async () => {
    global.fetch = fetchFinto([
      ['musicbrainz.org/ws/2/artist?query', () => ({ body: { artists: [] } })],
      ['/w/rest.php/v1/search/page', () => ({ body: { pages: [{ title: 'Gruppo Prova' }] } })],
      ['/w/api.php', () => ({ body: { query: { pages: { 1: { title: 'Gruppo Prova', extract: 'Un gruppo.' } } } } })],
      ['lmstudio.finto/v1/models', () => ({ body: { data: [{ id: 'qwen' }] } })],
      ['lmstudio.finto/v1/chat/completions', () => ({ status: 500, body: { error: 'guasto' } })]
    ]);
    const scheda = await servizio().artistInfo('Gruppo Prova', false);
    assert.equal(scheda.ai.failed, true);
    assert.equal(scheda.biography, 'Un gruppo.', 'senza sintesi resta il testo di Wikipedia');
    const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries : {};
    assert.equal(Object.keys(cache).length, 0);
  });

  it('le voci scadute spariscono dal file al salvataggio successivo', async () => {
    fs.writeFileSync(cacheFile, JSON.stringify({
      entries: { 'album:vecchia': { savedAt: Date.now() - 8 * 24 * 3600 * 1000, value: {} } }
    }));
    global.fetch = fetchFinto([
      ['musicbrainz.org/ws/2/release-group?query', () => ({ body: { 'release-groups': [] } })],
      ['/w/rest.php/v1/search/page', () => ({ body: { pages: [] } })]
    ]);
    await servizio().albumInfo({ artist: 'A', title: 'B', genre: [] }, false);
    const voci = Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries);
    assert.deepEqual(voci, ['album:v4:a:b']);
  });
});
