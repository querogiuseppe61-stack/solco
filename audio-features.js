'use strict';

// Analisi audio dei brani: estrae descrittori di "atmosfera" (valenza, energia,
// strumentale/cantato, mood) usando Essentia compilato in WebAssembly per il
// mel-spettrogramma e i modelli pre-addestrati di Essentia in formato ONNX.
//
// Scelte progettuali importanti:
// - Si analizzano piu' finestre brevi distribuite lungo il brano, non un blocco
//   unico centrale: su un pezzo con movimenti diversi (prog rock, suite) un solo
//   estratto centrale falsa completamente il risultato (verificato: arousal 6.1
//   invece di 4.1, "aggressivo" 1.0 invece di 0.35).
// - Il lavoro pesante gira in un worker thread, altrimenti il calcolo del
//   mel-spettrogramma (sincrono, dentro il WASM) bloccherebbe il server web.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MODEL_BASE = 'https://essentia.upf.edu/models';
const EMBEDDING_FILE = 'embedding-musicnn.onnx';

// Teste di classificazione scaricate insieme all'embedding. La chiave e' il nome
// del file, il valore dice quale classe tenere e con che nome esporla.
const HEADS = [
  { nome: 'emomusic', tipo: 'regressione', campi: { valence: 'valence', arousal: 'arousal' } },
  { nome: 'voice_instrumental', tipo: 'classe', campi: { instrumental: 'instrumental' } },
  { nome: 'mood_sad', tipo: 'classe', campi: { sad: 'sad' } },
  { nome: 'mood_relaxed', tipo: 'classe', campi: { relaxed: 'relaxed' } },
  { nome: 'mood_happy', tipo: 'classe', campi: { happy: 'happy' } },
  { nome: 'mood_aggressive', tipo: 'classe', campi: { aggressive: 'aggressive' } },
  { nome: 'mood_party', tipo: 'classe', campi: { party: 'party' } },
  { nome: 'mood_acoustic', tipo: 'classe', campi: { acoustic: 'acoustic' } },
  { nome: 'mood_electronic', tipo: 'classe', campi: { electronic: 'electronic' } },
  { nome: 'danceability', tipo: 'classe', campi: { danceable: 'danceable' } }
];

function headUrl(nome) {
  return MODEL_BASE + '/classification-heads/' + nome + '/' + nome + '-msd-musicnn-1';
}

function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function cacheKey(file) {
  const stat = fs.statSync(file);
  return pathKey(file) + '|' + stat.size + '|' + stat.mtimeMs;
}

// Trova ffmpeg: variabile d'ambiente, poi PATH di sistema. Non usiamo il pacchetto
// npm ffmpeg-static perche' il suo script di post-installazione viene bloccato
// dalle impostazioni npm predefinite di questa macchina, lasciando il binario assente.
// Il risultato viene memorizzato: lo stato dell'analisi viene interrogato ogni due
// secondi e senza cache ogni poll faceva partire un processo `which`.
let ffmpegCached;
function findFfmpeg() {
  if (ffmpegCached !== undefined) return ffmpegCached;
  ffmpegCached = cercaFfmpeg();
  return ffmpegCached;
}

function cercaFfmpeg() {
  if (process.env.SOLCO_FFMPEG && fs.existsSync(process.env.SOLCO_FFMPEG)) return process.env.SOLCO_FFMPEG;
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (out.length) return out[0];
  } catch (e) {}
  return null;
}

async function scaricaModelli(modelsDir, onLog) {
  fs.mkdirSync(modelsDir, { recursive: true });
  const mancanti = [];
  if (!fs.existsSync(path.join(modelsDir, EMBEDDING_FILE))) {
    mancanti.push({ url: MODEL_BASE + '/feature-extractors/musicnn/msd-musicnn-1.onnx', dest: EMBEDDING_FILE });
  }
  for (const h of HEADS) {
    if (!fs.existsSync(path.join(modelsDir, h.nome + '.onnx'))) mancanti.push({ url: headUrl(h.nome) + '.onnx', dest: h.nome + '.onnx' });
    if (!fs.existsSync(path.join(modelsDir, h.nome + '.json'))) mancanti.push({ url: headUrl(h.nome) + '.json', dest: h.nome + '.json' });
  }
  if (!mancanti.length) return { scaricati: 0 };

  for (const m of mancanti) {
    if (onLog) onLog('Scarico ' + m.dest + '…');
    const resp = await fetch(m.url);
    if (!resp.ok) throw new Error('Download fallito (' + resp.status + ') per ' + m.dest);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error('File vuoto ricevuto per ' + m.dest);
    fs.writeFileSync(path.join(modelsDir, m.dest), buf);
  }
  return { scaricati: mancanti.length };
}

// Quanti worker in parallelo. L'analisi e' tutta a carico della CPU, ma non scala
// linearmente coi core: misurato su 16 brani (Ryzen 5 4650U, 6 core / 12 thread)
// 1 worker 4.4 s a brano, 4 worker 1.62 (2.74x), 6 worker 1.51 (2.92x), 12 worker
// 1.47 (3.01x). Oltre i 4-6 la curva e' piatta perche' il limite non e' il numero
// di core ma il tetto di consumo del processore, che sotto carico pieno scende di
// frequenza. Il tetto predefinito a 4 prende quasi tutto il guadagno disponibile
// e lascia la macchina utilizzabile mentre lavora; con SOLCO_ANALISI_WORKER si
// puo' forzare qualsiasi valore.
const MAX_WORKER = 4;

function numeroWorker(quanti) {
  const richiesti = Number(process.env.SOLCO_ANALISI_WORKER);
  const cpu = (os.cpus() || []).length || 2;
  const tetto = Number.isFinite(richiesti) && richiesti >= 1
    ? Math.floor(richiesti)
    : Math.min(MAX_WORKER, Math.max(1, Math.floor(cpu / 2)));
  return Math.max(1, Math.min(tetto, quanti || 1));
}

// Una voce di cache e' persa quando nessun brano potra' mai piu' corrisponderle.
// Il caso da non sbagliare e' il disco esterno scollegato: li' il file non si trova
// ma la voce va tenuta, altrimenti al prossimo collegamento si rilegge tutto.
function vocePersa(file, size, mtime) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    // percorso di un altro sistema (lettera di unita' su Linux, o viceversa):
    // non tornera' valido nemmeno ricollegando qualcosa
    const altroSistema = process.platform === 'win32'
      ? file.startsWith('/')
      : /^[a-zA-Z]:[\\/]/.test(file);
    if (altroSistema) return true;
    try {
      // la cartella c'e' ma il file no: spostato o cancellato per davvero
      return fs.statSync(path.dirname(file)).isDirectory();
    } catch (e2) {
      // non c'e' nemmeno la cartella: quasi sempre un disco scollegato, si tiene
      return false;
    }
  }
  return String(stat.size) !== String(size) || String(stat.mtimeMs) !== String(mtime);
}

function creaCache(cacheFile) {
  let mappa = new Map();
  let sporca = false;

  function carica() {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (parsed && parsed.entries) {
        for (const [k, v] of Object.entries(parsed.entries)) mappa.set(k, v);
      }
    } catch (e) {}
  }

  function salva() {
    if (!sporca) return;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const entries = {};
      for (const [k, v] of mappa) entries[k] = v;
      const tmp = cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
      fs.renameSync(tmp, cacheFile);
      sporca = false;
    } catch (e) {}
  }

  // La chiave e' "percorso|dimensione|data": il percorso puo' contenere '|',
  // quindi si taglia dal fondo.
  function fileDellaChiave(k) {
    const taglioData = k.lastIndexOf('|');
    if (taglioData <= 0) return null;
    const taglioDim = k.lastIndexOf('|', taglioData - 1);
    if (taglioDim <= 0) return null;
    return {
      file: k.slice(0, taglioDim),
      size: k.slice(taglioDim + 1, taglioData),
      mtime: k.slice(taglioData + 1)
    };
  }

  // Il criterio lo decide il chiamante: la cache sa solo leggere le proprie chiavi.
  function chiaviChe(riguarda) {
    const trovate = [];
    for (const k of mappa.keys()) {
      const parti = fileDellaChiave(k);
      if (parti && riguarda(parti.file)) trovate.push(k);
    }
    return trovate;
  }

  function dimenticaSe(riguarda) {
    const chiavi = chiaviChe(riguarda);
    if (!chiavi.length) return 0;
    for (const k of chiavi) mappa.delete(k);
    sporca = true;
    salva();
    return chiavi.length;
  }

  function pota() {
    let rimosse = 0;
    for (const k of [...mappa.keys()]) {
      const parti = fileDellaChiave(k);
      if (!parti || !vocePersa(parti.file, parti.size, parti.mtime)) continue;
      mappa.delete(k);
      sporca = true;
      rimosse++;
    }
    if (rimosse) salva();
    return rimosse;
  }

  carica();
  return {
    get: (k) => mappa.get(k),
    has: (k) => mappa.has(k),
    set: (k, v) => { mappa.set(k, v); sporca = true; },
    size: () => mappa.size,
    conta: (riguarda) => chiaviChe(riguarda).length,
    dimenticaSe,
    pota,
    salva
  };
}

function createAudioFeatureService(options) {
  const cacheDir = options.cacheDir;
  const modelsDir = path.join(cacheDir, 'models');
  const cache = creaCache(path.join(cacheDir, 'audio-features.json'));

  let pool = [];
  // Chiesta l'interruzione: l'analisi resta "attiva" finche' i worker non hanno
  // finito il brano in corso e il pool non e' chiuso. Prima attivo tornava falso
  // subito, l'interfaccia riabilitava Avvia e una nuova analisi partiva mentre la
  // vecchia girava ancora: la chiusura di quest'ultima terminava i worker nuovi.
  let interrotta = false;

  const stato = {
    attivo: false,
    fatti: 0,
    totali: 0,
    saltati: 0,
    errori: 0,
    worker: 0,
    corrente: null,
    messaggio: '',
    iniziato: null,
    ultimoErrore: null
  };

  // Un worker del pool: incapsula la sua coda di richieste in sospeso, cosi' due
  // worker non possono confondersi le risposte fra loro.
  function creaWorker(ffmpeg) {
    const { Worker } = require('worker_threads');
    const w = new Worker(path.join(__dirname, 'audio-worker.js'), { workerData: { modelsDir, ffmpeg } });
    const inSospeso = new Map();
    let prossimoId = 1;
    let morto = false;

    const pronto = new Promise((resolve, reject) => {
      const onMsg = (m) => {
        if (m.tipo === 'pronto') { w.off('message', onMsg); resolve(); }
        else if (m.tipo === 'errore-init') { w.off('message', onMsg); reject(new Error(m.errore)); }
      };
      w.on('message', onMsg);
      w.on('error', reject);
      w.once('exit', (code) => reject(new Error('motore di analisi terminato all\'avvio (codice ' + code + ')')));
    });
    // se il worker muore la promessa di init e' gia' risolta: le richieste in volo
    // vanno comunque rifiutate, altrimenti l'analisi resta appesa per sempre
    pronto.catch(() => {});

    w.on('message', (m) => {
      if (m.tipo !== 'risultato') return;
      const pend = inSospeso.get(m.id);
      if (!pend) return;
      inSospeso.delete(m.id);
      if (m.errore) pend.reject(new Error(m.errore));
      else pend.resolve(m.features);
    });
    const rifiutaTutte = (e) => {
      morto = true;
      for (const [, p] of inSospeso) p.reject(e);
      inSospeso.clear();
    };
    w.on('error', (e) => {
      stato.ultimoErrore = e.message;
      rifiutaTutte(e);
    });
    // un'uscita senza 'error' (terminate, process.exit nel worker) lasciava appese
    // le richieste in volo
    w.on('exit', (code) => rifiutaTutte(new Error('motore di analisi terminato (codice ' + code + ')')));

    return {
      pronto,
      vivo: () => !morto,
      termina: () => { try { w.terminate(); } catch (e) {} },
      analizza(file, durata) {
        if (morto) return Promise.reject(new Error('motore di analisi non disponibile'));
        return new Promise((resolve, reject) => {
          const id = prossimoId++;
          inSospeso.set(id, { resolve, reject });
          w.postMessage({ tipo: 'analizza', id, file, durata });
        });
      }
    };
  }

  async function avviaPool(ffmpeg, quanti) {
    pool = [];
    for (let i = 0; i < quanti; i++) pool.push(creaWorker(ffmpeg));
    try {
      await Promise.all(pool.map((p) => p.pronto));
    } catch (e) {
      fermaPool();
      throw e;
    }
  }

  function fermaPool() {
    for (const p of pool) p.termina();
    pool = [];
  }

  function featuresDi(file) {
    try {
      return cache.get(cacheKey(file)) || null;
    } catch (e) {
      return null;
    }
  }

  function quantiMancano(brani) {
    let n = 0;
    for (const b of brani) {
      try {
        if (!cache.has(cacheKey(b.file))) n++;
      } catch (e) {}
    }
    return n;
  }

  // brani: [{ file, durata }]
  async function avviaAnalisi(brani, opzioni) {
    if (stato.attivo) return { ok: false, error: 'Analisi già in corso' };
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
      return {
        ok: false,
        error: 'ffmpeg non trovato. Installalo (Windows: winget install Gyan.FFmpeg — macOS: brew install ffmpeg — Linux: dal gestore pacchetti) oppure indica il percorso con la variabile SOLCO_FFMPEG.'
      };
    }

    stato.attivo = true;
    interrotta = false;
    stato.fatti = 0;
    stato.saltati = 0;
    stato.errori = 0;
    stato.corrente = null;
    stato.iniziato = Date.now();
    stato.ultimoErrore = null;
    stato.messaggio = 'Preparazione…';

    const daFare = [];
    for (const b of brani) {
      try {
        if (!cache.has(cacheKey(b.file))) daFare.push(b);
        else stato.saltati++;
      } catch (e) {
        stato.errori++;
      }
    }
    stato.totali = daFare.length;

    const quantiWorker = numeroWorker(daFare.length);
    stato.worker = quantiWorker;

    (async () => {
      try {
        stato.messaggio = 'Verifica dei modelli…';
        await scaricaModelli(modelsDir, (m) => { stato.messaggio = m; });
        stato.messaggio = quantiWorker > 1
          ? 'Avvio di ' + quantiWorker + ' motori di analisi…'
          : 'Avvio del motore di analisi…';
        await avviaPool(ffmpeg, quantiWorker);
        stato.messaggio = 'Analisi in corso';

        // I worker pescano dalla stessa lista tramite un cursore condiviso: chi
        // finisce prima prende il brano successivo, cosi' un pezzo lungo non
        // blocca gli altri (una divisione in blocchi fissi lo farebbe).
        let cursore = 0;
        async function consuma(p) {
          while (!interrotta && p.vivo()) {
            const i = cursore++;
            if (i >= daFare.length) return;
            const b = daFare[i];
            stato.corrente = b.titolo || path.basename(b.file);
            try {
              const chiave = cacheKey(b.file);
              const features = await p.analizza(b.file, b.durata);
              cache.set(chiave, features);
              stato.fatti++;
            } catch (e) {
              stato.errori++;
              stato.ultimoErrore = e.message;
            }
            if (stato.fatti % 25 === 0) cache.salva();
          }
        }
        await Promise.all(pool.map(consuma));

        cache.salva();
        if (!interrotta && !pool.some((p) => p.vivo())) {
          // i worker sono morti prima di finire la lista: non e' un completamento
          stato.messaggio = 'Analisi interrotta: il motore di analisi è terminato in modo anomalo';
        } else {
          stato.messaggio = interrotta ? 'Analisi interrotta' : 'Analisi completata';
        }
      } catch (e) {
        stato.messaggio = 'Analisi non riuscita: ' + e.message;
        stato.ultimoErrore = e.message;
      } finally {
        stato.attivo = false;
        stato.corrente = null;
        fermaPool();
        cache.salva();
      }
    })();

    return { ok: true, daAnalizzare: daFare.length, giaInCache: stato.saltati, worker: quantiWorker };
  }

  function fermaAnalisi() {
    if (!stato.attivo) return { ok: false, error: 'Nessuna analisi in corso' };
    interrotta = true;
    stato.messaggio = 'Interruzione…';
    return { ok: true };
  }

  function statoAnalisi() {
    return {
      attivo: stato.attivo,
      fatti: stato.fatti,
      totali: stato.totali,
      saltati: stato.saltati,
      errori: stato.errori,
      worker: stato.worker,
      iniziato: stato.iniziato,
      corrente: stato.corrente,
      messaggio: stato.messaggio,
      inCache: cache.size(),
      ultimoErrore: stato.ultimoErrore,
      ffmpeg: !!findFfmpeg()
    };
  }

  return {
    featuresDi,
    quantiMancano,
    avviaAnalisi,
    fermaAnalisi,
    statoAnalisi,
    cacheKey,
    potaCache: () => cache.pota(),
    contaCache: (riguarda) => cache.conta(riguarda),
    dimenticaDallaCache: (riguarda) => cache.dimenticaSe(riguarda)
  };
}

module.exports = {
  HEADS, EMBEDDING_FILE, MODEL_BASE, headUrl, pathKey, cacheKey,
  findFfmpeg, scaricaModelli, creaCache, numeroWorker, vocePersa, createAudioFeatureService
};
