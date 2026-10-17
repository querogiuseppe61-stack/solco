'use strict';

// Strumenti comuni ai test: libreria di prova, copia dell'app in una cartella
// temporanea e server avviato su una porta libera. Il server lavora sempre accanto
// a server.js (music/, cache/, *.json), quindi lo si fa girare su una copia: i test
// non toccano mai i dati veri nella cartella dell'app.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const RADICE = path.join(__dirname, '..');

function cartellaTemporanea(prefisso) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'solco-' + (prefisso || 'test') + '-'));
}

// WAV PCM 16 bit mono di silenzio: music-metadata ne legge la durata e non serve
// ffmpeg per generarlo.
function wav(secondi, frequenza) {
  const rate = frequenza || 8000;
  const byteDati = Math.round(secondi * rate) * 2;
  const b = Buffer.alloc(44 + byteDati);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + byteDati, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(byteDati, 40);
  return b;
}

// Il minimo che basta a passare il controllo dei primi byte delle copertine.
const JPEG_FINTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

// file: { 'Cartella/brano.wav': Buffer | string }
function scriviFile(base, file) {
  for (const [rel, contenuto] of Object.entries(file)) {
    const dest = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, contenuto);
  }
}

function copiaApp(dest, sostituzioni) {
  for (const nome of fs.readdirSync(RADICE)) {
    if (nome.endsWith('.js')) fs.copyFileSync(path.join(RADICE, nome), path.join(dest, nome));
  }
  fs.cpSync(path.join(RADICE, 'public'), path.join(dest, 'public'), { recursive: true });
  // 'junction' su Windows non chiede privilegi; altrove il tipo viene ignorato
  fs.symlinkSync(path.join(RADICE, 'node_modules'), path.join(dest, 'node_modules'), 'junction');
  for (const [nome, contenuto] of Object.entries(sostituzioni || {})) {
    fs.writeFileSync(path.join(dest, nome), contenuto);
  }
}

function portaLibera() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const porta = s.address().port;
      s.close(() => resolve(porta));
    });
  });
}

// opzioni: { musica, file, sostituzioni, env }
// - musica: file da mettere in music/ prima dell'avvio
// - file: altri file relativi alla cartella dell'app (es. cache/models/...)
// - sostituzioni: moduli dell'app da rimpiazzare (es. un audio-worker finto)
async function avviaApp(opzioni) {
  const o = opzioni || {};
  const dir = cartellaTemporanea('app');
  copiaApp(dir, o.sostituzioni);
  scriviFile(path.join(dir, 'music'), o.musica || {});
  scriviFile(dir, o.file || {});
  const porta = await portaLibera();

  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('SOLCO_') && k !== 'PORT') env[k] = v;
  Object.assign(env, {
    PORT: String(porta),
    SOLCO_CONFIG_DIR: path.join(dir, '_config'),
    // porta chiusa: LM Studio risulta sempre spento, anche se gira su questa macchina
    SOLCO_LMSTUDIO_URL: 'http://127.0.0.1:9/v1'
  }, o.env || {});

  const figlio = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let uscita = '';
  figlio.stdout.on('data', (d) => { uscita += d; });
  figlio.stderr.on('data', (d) => { uscita += d; });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Il server non si e\' avviato:\n' + uscita)), 30000);
    const controlla = () => {
      if (uscita.includes('Solco attivo')) {
        clearTimeout(timer);
        figlio.stdout.off('data', controlla);
        resolve();
      }
    };
    figlio.stdout.on('data', controlla);
    figlio.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Il server e\' uscito (codice ' + code + '):\n' + uscita));
    });
  });

  return {
    dir,
    porta,
    log: () => uscita,
    richiesta: (opz) => richiesta(porta, opz),
    get: (p, headers) => richiesta(porta, { path: p, headers }),
    invia: (metodo, p, corpo) => richiesta(porta, { method: metodo, path: p, json: corpo }),
    async ferma() {
      if (figlio.exitCode === null) {
        await new Promise((resolve) => {
          figlio.once('exit', resolve);
          figlio.kill();
        });
      }
      rimuovi(dir);
    }
  };
}

// Il collegamento a node_modules va tolto per primo: rm ricorsivo non deve
// nemmeno avvicinarsi alle dipendenze vere.
function rimuovi(dir) {
  try {
    fs.unlinkSync(path.join(dir, 'node_modules'));
  } catch (e) {}
  fs.rmSync(dir, { recursive: true, force: true });
}

// http.request e non fetch: servono header come Host e Origin, che fetch non
// lascia impostare.
function richiesta(porta, opzioni) {
  const o = opzioni || {};
  return new Promise((resolve, reject) => {
    const headers = { ...(o.headers || {}) };
    let corpo = o.body;
    if (o.json !== undefined) {
      corpo = JSON.stringify(o.json);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    // senza lunghezza Node non manda il corpo delle DELETE (niente chunked di default)
    if (corpo !== undefined && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(corpo);
    const req = http.request({
      host: '127.0.0.1',
      port: porta,
      method: o.method || 'GET',
      path: o.path || '/',
      headers
    }, (res) => {
      const pezzi = [];
      res.on('data', (c) => pezzi.push(c));
      res.on('end', () => {
        const body = Buffer.concat(pezzi);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          text: () => body.toString('utf8'),
          json: () => JSON.parse(body.toString('utf8'))
        });
      });
    });
    // un server che risponde prima di aver letto tutto il corpo (413) puo' chiudere
    // mentre stiamo ancora scrivendo: conta la risposta, non l'errore di scrittura
    req.on('error', (e) => {
      if (e.code !== 'EPIPE' && e.code !== 'ECONNRESET') reject(e);
    });
    if (corpo !== undefined) req.write(corpo);
    req.end();
  });
}

async function aspetta(condizione, msMax, descrizione) {
  const fine = Date.now() + (msMax || 10000);
  for (;;) {
    const esito = await condizione();
    if (esito) return esito;
    if (Date.now() > fine) throw new Error('Tempo scaduto: ' + (descrizione || 'condizione mai verificata'));
    await new Promise((r) => setTimeout(r, 50));
  }
}

module.exports = { RADICE, cartellaTemporanea, wav, JPEG_FINTO, scriviFile, avviaApp, richiesta, aspetta, rimuovi };
