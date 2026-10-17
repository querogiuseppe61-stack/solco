'use strict';

// Worker thread: decodifica, mel-spettrogramma e inferenza dei modelli.
// Gira fuori dal thread principale perche' il calcolo del mel dentro il WASM
// e' sincrono e bloccherebbe il server web per l'intera durata dell'analisi.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { parentPort, workerData } = require('worker_threads');
const ort = require('onnxruntime-node');
const { EssentiaWASM, EssentiaModel } = require('essentia.js');
const { HEADS, EMBEDDING_FILE } = require('./audio-features');

const SR = 16000;
const FRAME = 512;
const HOP = 256;
const PATCH_FRAMES = 187;
const MEL_BANDS = 96;
const FINESTRA_SEC = 20;
const FINESTRE_MIN = 3;
const FINESTRE_MAX = 6;

const { modelsDir, ffmpeg } = workerData;

// Un solo thread per sessione ONNX. Lasciato libero, onnxruntime apre da solo un
// thread per core: con piu' worker in parallelo finiscono per litigarsi la CPU e
// il guadagno si perde. Misurato su 16 brani: con i thread automatici quattro
// worker davano 1.87x, con questa opzione danno 2.74x. Su un worker solo la
// differenza e' entro l'1%, quindi non c'e' motivo di renderla condizionale.
const OPZ_ORT = { intraOpNumThreads: 1, interOpNumThreads: 1 };

let emb = null;
let heads = null;
let extractor = null;

async function inizializza() {
  emb = await ort.InferenceSession.create(path.join(modelsDir, EMBEDDING_FILE), OPZ_ORT);
  heads = [];
  for (const h of HEADS) {
    const meta = JSON.parse(fs.readFileSync(path.join(modelsDir, h.nome + '.json'), 'utf8'));
    heads.push({
      def: h,
      sess: await ort.InferenceSession.create(path.join(modelsDir, h.nome + '.onnx'), OPZ_ORT),
      classi: meta.classes || []
    });
  }
  extractor = new EssentiaModel.EssentiaTFInputExtractor(EssentiaWASM, 'musicnn', false);
}

// Quante finestre campionare: piu' il brano e' lungo, piu' punti servono per
// rappresentarlo senza tradire i pezzi articolati.
function numeroFinestre(durata) {
  if (!Number.isFinite(durata) || durata <= 0) return FINESTRE_MIN;
  return Math.max(FINESTRE_MIN, Math.min(FINESTRE_MAX, Math.round(durata / 120)));
}

function decodeSegmento(file, start, dur, tmpFile) {
  const args = ['-y', '-ss', String(Math.max(0, start)), '-i', file, '-t', String(dur),
    '-ac', '1', '-ar', String(SR), '-f', 'f32le', tmpFile];
  try {
    execFileSync(ffmpeg, args, { stdio: 'ignore', timeout: 60000 });
  } catch (e) {
    // ffmpeg puo' aver gia' scritto un pezzo di file prima di fallire
    try { fs.unlinkSync(tmpFile); } catch (e2) {}
    // il messaggio grezzo di execFileSync riporta l'intera riga di comando: inutile
    // da mostrare in interfaccia, meglio dire cosa e' successo davvero
    throw new Error('decodifica non riuscita (file danneggiato o formato non supportato)');
  }
  const buf = fs.readFileSync(tmpFile);
  const out = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  try { fs.unlinkSync(tmpFile); } catch (e) {}
  return out;
}

// Restituisce le finestre separate, non un unico segnale: sono spezzoni presi da
// punti distanti del brano e attaccarli produrrebbe una giunzione che non esiste
// nella musica.
function estraiFinestre(file, durata) {
  const tmpFile = path.join(os.tmpdir(), 'solco-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.pcm');
  if (!Number.isFinite(durata) || durata <= FINESTRA_SEC * FINESTRE_MIN) {
    // brano corto: si analizza per intero
    return [decodeSegmento(file, 0, Math.max(durata || 60, 5), tmpFile)];
  }
  const n = numeroFinestre(durata);
  const finestre = [];
  for (let i = 1; i <= n; i++) {
    const centro = durata * (i / (n + 1));
    finestre.push(decodeSegmento(file, Math.max(0, centro - FINESTRA_SEC / 2), FINESTRA_SEC, tmpFile));
  }
  return finestre;
}

// Il mel-spettrogramma non passa da extractor.compute(): quel metodo alloca due
// vettori nel heap WASM per ogni frame (l'ingresso e le bande restituite) e non
// ne libera nessuno. Sono una decina di MB per brano, e il heap WASM si ferma a
// 2 GB: dopo qualche centinaio di brani il worker moriva e l'analisi si fermava.
// Qui si chiama l'algoritmo direttamente e si liberano a mano; i valori sono
// identici a quelli di compute().
function melDelFrame(frame) {
  const vettore = EssentiaWASM.arrayToVector(frame);
  let spettro = null;
  try {
    spettro = extractor.essentia.TensorflowInputMusiCNN(vettore);
    return EssentiaWASM.vectorToArray(spettro.bands);
  } finally {
    if (spettro && spettro.bands) spettro.bands.delete();
    vettore.delete();
  }
}

function patchDaFrame(frames, i) {
  const p = new Float32Array(PATCH_FRAMES * MEL_BANDS);
  for (let f = 0; f < PATCH_FRAMES; f++) p.set(frames[Math.min(i + f, frames.length - 1)], f * MEL_BANDS);
  return p;
}

// Ogni patch nasce dentro una sola finestra. Concatenando prima le finestre, una o
// due patch per brano cadevano a cavallo della giunzione e mescolavano due momenti
// lontani del pezzo.
//
// L'avanzo di coda (una finestra da 20 s da' sei patch piene e circa 2 s di
// resto) non si butta: diventa un'ultima patch ancorata alla fine della finestra,
// che si sovrappone in parte alla precedente. Scartarlo avrebbe significato
// rinunciare al 10% dell'audio campionato solo per evitare la giuntura.
const RESTO_MINIMO = PATCH_FRAMES / 4;

function costruisciPatch(finestre) {
  const patches = [];
  let riserva = [];
  for (const finestra of finestre) {
    const frames = [];
    for (let s = 0; s + FRAME <= finestra.length; s += HOP) {
      frames.push(melDelFrame(finestra.subarray(s, s + FRAME)));
    }
    let i = 0;
    for (; i + PATCH_FRAMES <= frames.length; i += PATCH_FRAMES) {
      patches.push(patchDaFrame(frames, i));
    }
    if (i && frames.length - i >= RESTO_MINIMO) {
      patches.push(patchDaFrame(frames, frames.length - PATCH_FRAMES));
    }
    if (frames.length > riserva.length) riserva = frames;
  }
  // brano piu' corto di una patch: si ripete l'ultimo frame fino a riempirla
  if (!patches.length && riserva.length) patches.push(patchDaFrame(riserva, 0));
  return patches;
}

// Le patch di un brano passano nel modello a gruppi, non tutte insieme: onnxruntime
// dimensiona la propria arena sul batch piu' grande visto e non la restituisce mai.
// Con tutte le patch in un colpo solo il worker arrivava a 1.6 GB, e sono quattro
// in parallelo. A gruppi di 4 resta sotto i 400 MB, negli stessi tempi: i valori
// cambiano nell'ordine del milionesimo, invisibile dopo l'arrotondamento finale.
const PATCH_PER_LOTTO = 4;

async function calcolaEmbedding(patches) {
  const pezzi = [];
  let larghezza = 0;
  for (let i = 0; i < patches.length; i += PATCH_PER_LOTTO) {
    const lotto = patches.slice(i, i + PATCH_PER_LOTTO);
    const piatto = new Float32Array(lotto.length * PATCH_FRAMES * MEL_BANDS);
    lotto.forEach((p, j) => piatto.set(p, j * PATCH_FRAMES * MEL_BANDS));
    const uscita = await emb.run({
      melspectrogram: new ort.Tensor('float32', piatto, [lotto.length, PATCH_FRAMES, MEL_BANDS])
    });
    larghezza = uscita.embeddings.dims[1];
    pezzi.push(uscita.embeddings.data);
  }
  const dati = new Float32Array(patches.length * larghezza);
  let o = 0;
  for (const p of pezzi) {
    dati.set(p, o);
    o += p.length;
  }
  return new ort.Tensor('float32', dati, [patches.length, larghezza]);
}

async function analizza(file, durata) {
  const patches = costruisciPatch(estraiFinestre(file, durata));
  if (!patches.length) throw new Error('audio non analizzabile');

  const e2 = await calcolaEmbedding(patches);
  // le teste di regressione vogliono [N,1,200], quelle di classificazione [N,200]
  const e3 = new ort.Tensor('float32', e2.data, [e2.dims[0], 1, e2.dims[1]]);

  const risultato = {};
  for (const h of heads) {
    let r;
    try {
      r = await h.sess.run({ embeddings: e2 });
    } catch (err) {
      if (!/Invalid rank/.test(err.message)) throw err;
      r = await h.sess.run({ embeddings: e3 });
    }
    const act = r.activations;
    const nClassi = act.dims[1];
    for (const [campo, classe] of Object.entries(h.def.campi)) {
      // l'ordine delle classi cambia da modello a modello: si legge dal metadato
      const idx = h.classi.indexOf(classe);
      if (idx < 0) continue;
      let somma = 0;
      for (let p = 0; p < act.dims[0]; p++) somma += act.data[p * nClassi + idx];
      risultato[campo] = Number((somma / act.dims[0]).toFixed(3));
    }
  }
  risultato.patch = patches.length;
  return risultato;
}

let pronto = inizializza().then(
  () => parentPort.postMessage({ tipo: 'pronto' }),
  (e) => parentPort.postMessage({ tipo: 'errore-init', errore: e.message })
);

parentPort.on('message', async (msg) => {
  if (msg.tipo !== 'analizza') return;
  await pronto;
  try {
    const features = await analizza(msg.file, msg.durata);
    parentPort.postMessage({ tipo: 'risultato', id: msg.id, features });
  } catch (e) {
    parentPort.postMessage({ tipo: 'risultato', id: msg.id, errore: e.message });
  }
});
