'use strict';

// Ciclo di vita dell'analisi audio (avvio, interruzione, riavvio, worker che
// muore) con un worker finto: niente ffmpeg, niente modelli Essentia, niente
// onnxruntime. Si prova la regia del pool, non il calcolo.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { avviaApp, wav, aspetta } = require('./helpers');
const { HEADS, EMBEDDING_FILE } = require('../audio-features');

// Comportamento scelto con SOLCO_TEST_WORKER: "lento" risponde dopo un attimo,
// "muore" esce con process.exit al primo brano (uscita senza evento 'error').
const WORKER_FINTO = `
const { parentPort } = require('worker_threads');
parentPort.postMessage({ tipo: 'pronto' });
parentPort.on('message', (m) => {
  if (process.env.SOLCO_TEST_WORKER === 'muore') process.exit(3);
  setTimeout(() => parentPort.postMessage({ tipo: 'risultato', id: m.id, features: { valence: 0.5 } }), 150);
});
`;

function modelliFinti() {
  const file = { ['cache/models/' + EMBEDDING_FILE]: 'x' };
  for (const h of HEADS) {
    file['cache/models/' + h.nome + '.onnx'] = 'x';
    file['cache/models/' + h.nome + '.json'] = '{}';
  }
  return file;
}

function musica(quanti) {
  const m = {};
  for (let i = 1; i <= quanti; i++) m['Artista - Disco/' + String(i).padStart(2, '0') + ' - Brano.wav'] = wav(1);
  return m;
}

async function avvia(modo) {
  return avviaApp({
    musica: musica(8),
    file: modelliFinti(),
    sostituzioni: { 'audio-worker.js': WORKER_FINTO },
    env: {
      SOLCO_TEST_WORKER: modo,
      SOLCO_ANALISI_WORKER: '1',
      // basta che il file esista: il worker finto non lo usa
      SOLCO_FFMPEG: process.execPath
    }
  });
}

const stato = async (app) => (await app.get('/api/audio-analysis/status')).json();

describe('analisi audio', () => {
  describe('interruzione e riavvio', () => {
    let app;
    before(async () => { app = await avvia('lento'); });
    after(async () => { if (app) await app.ferma(); });

    it('resta attiva finche\' l\'interruzione non e\' davvero finita', async () => {
      const avvio = await app.invia('POST', '/api/audio-analysis/start');
      assert.equal(avvio.status, 200);
      assert.equal(avvio.json().daAnalizzare, 8);

      await aspetta(async () => (await stato(app)).corrente, 5000, 'l\'analisi doveva partire');
      assert.equal((await app.invia('POST', '/api/audio-analysis/stop')).status, 200);

      const durante = await stato(app);
      assert.equal(durante.attivo, true);
      assert.equal(durante.messaggio, 'Interruzione…');
      // un nuovo avvio mentre la vecchia corsa sta chiudendo va rifiutato
      assert.equal((await app.invia('POST', '/api/audio-analysis/start')).status, 409);

      const fine = await aspetta(async () => {
        const s = await stato(app);
        return !s.attivo && s;
      }, 5000, 'l\'interruzione doveva concludersi');
      assert.equal(fine.messaggio, 'Analisi interrotta');
      assert.ok(fine.fatti < 8);
    });

    it('un riavvio riprende dai brani mancanti e arriva in fondo', async () => {
      const prima = await stato(app);
      const avvio = await app.invia('POST', '/api/audio-analysis/start');
      assert.equal(avvio.status, 200);
      assert.equal(avvio.json().giaInCache, prima.inCache);
      assert.equal(avvio.json().daAnalizzare, 8 - prima.inCache);

      const fine = await aspetta(async () => {
        const s = await stato(app);
        return !s.attivo && s;
      }, 10000, 'l\'analisi doveva finire');
      assert.equal(fine.messaggio, 'Analisi completata');
      assert.equal(fine.errori, 0);
      assert.equal(fine.inCache, 8);
      assert.equal(fine.daAnalizzare, 0);

      // tutto in cache: un nuovo avvio non ha niente da fare
      const ancora = (await app.invia('POST', '/api/audio-analysis/start')).json();
      assert.equal(ancora.daAnalizzare, 0);
    });

    it('fermare quando non c\'e\' nulla in corso e\' un errore innocuo', async () => {
      await aspetta(async () => !(await stato(app)).attivo, 5000);
      assert.equal((await app.invia('POST', '/api/audio-analysis/stop')).json().ok, false);
    });
  });

  describe('worker che muore', () => {
    let app;
    before(async () => { app = await avvia('muore'); });
    after(async () => { if (app) await app.ferma(); });

    it('l\'analisi si chiude con un errore invece di restare appesa', async () => {
      assert.equal((await app.invia('POST', '/api/audio-analysis/start')).status, 200);
      const fine = await aspetta(async () => {
        const s = await stato(app);
        return !s.attivo && s;
      }, 5000, 'l\'analisi e\' rimasta appesa');
      assert.match(fine.messaggio, /terminato in modo anomalo/);
      assert.equal(fine.errori, 1);
      assert.match(fine.ultimoErrore, /codice 3/);
    });
  });
});
