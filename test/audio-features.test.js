'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cartellaTemporanea } = require('./helpers');
const { vocePersa, numeroWorker, creaCache, cacheKey, pathKey } = require('../audio-features');

describe('vocePersa', () => {
  let dir;
  let file;
  let stat;
  before(() => {
    dir = cartellaTemporanea('voce');
    file = path.join(dir, 'brano.flac');
    fs.writeFileSync(file, 'abc');
    stat = fs.statSync(file);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('tiene la voce di un file invariato', () => {
    assert.equal(vocePersa(file, stat.size, stat.mtimeMs), false);
    // nella chiave della cache i numeri arrivano come testo
    assert.equal(vocePersa(file, String(stat.size), String(stat.mtimeMs)), false);
  });

  it('scarta la voce di un file cambiato', () => {
    assert.equal(vocePersa(file, stat.size + 1, stat.mtimeMs), true);
    assert.equal(vocePersa(file, stat.size, stat.mtimeMs + 1000), true);
  });

  it('scarta la voce di un file cancellato da una cartella che esiste', () => {
    assert.equal(vocePersa(path.join(dir, 'sparito.flac'), 1, 1), true);
  });

  it('tiene la voce quando manca l\'intera cartella (disco scollegato)', () => {
    assert.equal(vocePersa(path.join(dir, 'disco-esterno', 'album', 'brano.flac'), 1, 1), false);
  });

  it('scarta i percorsi di un altro sistema operativo', () => {
    const altro = process.platform === 'win32' ? '/home/utente/Musica/x.flac' : 'D:\\Musica\\x.flac';
    assert.equal(vocePersa(altro, 1, 1), true);
  });
});

describe('numeroWorker', () => {
  const originale = process.env.SOLCO_ANALISI_WORKER;
  afterEach(() => {
    if (originale === undefined) delete process.env.SOLCO_ANALISI_WORKER;
    else process.env.SOLCO_ANALISI_WORKER = originale;
  });

  it('senza variabile resta fra 1 e 4', () => {
    delete process.env.SOLCO_ANALISI_WORKER;
    const n = numeroWorker(100);
    assert.ok(n >= 1 && n <= 4, String(n));
  });

  it('non supera il numero di brani e non scende sotto 1', () => {
    process.env.SOLCO_ANALISI_WORKER = '8';
    assert.equal(numeroWorker(100), 8);
    assert.equal(numeroWorker(3), 3);
    assert.equal(numeroWorker(0), 1);
  });

  it('ignora valori non validi', () => {
    for (const v of ['0', '-2', 'tanti']) {
      process.env.SOLCO_ANALISI_WORKER = v;
      const n = numeroWorker(100);
      assert.ok(n >= 1 && n <= 4, v + ' -> ' + n);
    }
    process.env.SOLCO_ANALISI_WORKER = '2.9';
    assert.equal(numeroWorker(100), 2);
  });
});

describe('creaCache', () => {
  let dir;
  before(() => { dir = cartellaTemporanea('cache'); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('salva in modo persistente e rilegge', () => {
    const file = path.join(dir, 'a.json');
    const c = creaCache(file);
    c.set('/m/x.flac|1|2', { valence: 0.4 });
    assert.equal(fs.existsSync(file), false, 'set da solo non scrive');
    c.salva();
    const riletta = creaCache(file);
    assert.deepEqual(riletta.get('/m/x.flac|1|2'), { valence: 0.4 });
    assert.equal(riletta.size(), 1);
    assert.equal(fs.existsSync(file + '.tmp'), false);
  });

  it('legge le chiavi dal fondo: il percorso puo\' contenere "|"', () => {
    const c = creaCache(path.join(dir, 'b.json'));
    c.set('/m/AC|DC/brano.flac|10|20', {});
    c.set('/m/altro.flac|10|20', {});
    assert.equal(c.conta((f) => f === '/m/AC|DC/brano.flac'), 1);
    assert.equal(c.conta((f) => f.startsWith('/m/')), 2);
  });

  it('dimentica le voci scelte e salva subito', () => {
    const file = path.join(dir, 'c.json');
    const c = creaCache(file);
    c.set('/disco/a.flac|1|1', {});
    c.set('/disco/b.flac|1|1', {});
    c.set('/altro/c.flac|1|1', {});
    assert.equal(c.dimenticaSe((f) => f.startsWith('/disco/')), 2);
    assert.equal(creaCache(file).size(), 1);
    assert.equal(c.dimenticaSe(() => false), 0);
  });

  it('pota le voci dei file spariti ma non quelle dei dischi scollegati', () => {
    const vero = path.join(dir, 'vero.flac');
    fs.writeFileSync(vero, 'abc');
    const c = creaCache(path.join(dir, 'd.json'));
    c.set(cacheKey(vero), { ok: 1 });
    c.set(path.join(dir, 'cancellato.flac') + '|3|1', {});
    c.set(path.join(dir, 'scollegato', 'x.flac') + '|3|1', {});
    assert.equal(c.pota(), 1);
    assert.equal(c.size(), 2);
    assert.ok(c.has(cacheKey(vero)));
  });

  it('un file di cache rovinato vale come cache vuota', () => {
    const file = path.join(dir, 'rotto.json');
    fs.writeFileSync(file, '{non json');
    assert.equal(creaCache(file).size(), 0);
  });
});

describe('cacheKey', () => {
  it('include percorso assoluto, dimensione e data', () => {
    const dir = cartellaTemporanea('chiave');
    try {
      const file = path.join(dir, 'x.wav');
      fs.writeFileSync(file, '12345');
      const st = fs.statSync(file);
      assert.equal(cacheKey(file), pathKey(file) + '|5|' + st.mtimeMs);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
