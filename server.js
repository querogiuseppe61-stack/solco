'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream');
const { createWebInfoService } = require('./web-info');
const { createAiPlaylistService } = require('./ai-playlist');
const { createRadioSolcoService } = require('./radio-solco');
const { createAudioFeatureService, vocePersa } = require('./audio-features');
const { createAiConfigStore } = require('./ai-config');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MUSIC_DIR = path.join(ROOT, 'music');
const PLAYLISTS_FILE = path.join(ROOT, 'playlists.json');
const RADIO_FILE = path.join(ROOT, 'radio-solco.json');
const LIBRARY_FILE = path.join(ROOT, 'library.json');
const ALBUM_OVERRIDES_FILE = path.join(ROOT, 'album-overrides.json');
const STATS_FILE = path.join(ROOT, 'stats.json');
const WEB_CACHE_FILE = path.join(ROOT, 'web-cache.json');
const AI_CONFIG_FILE = path.join(ROOT, 'ai-config.json');
const CACHE_DIR = path.join(ROOT, 'cache');
const INDEX_FILE = path.join(CACHE_DIR, 'metadata-index.json');
const COVER_CACHE_DIR = path.join(CACHE_DIR, 'covers');
const PORT = process.env.PORT || 3747;
const HOST = process.env.SOLCO_HOST || '127.0.0.1';
// Host aggiuntivi ammessi nell'header Host, separati da virgola. Serve solo a chi
// espone Solco fuori da 127.0.0.1 (SOLCO_HOST=0.0.0.0 e accesso dalla rete locale).
const EXTRA_HOSTS = new Set(
  String(process.env.SOLCO_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);
if (HOST !== '0.0.0.0' && HOST !== '::') EXTRA_HOSTS.add(HOST.toLowerCase());

// La chiave OpenRouter non sta in ai-config.json ma nella cartella di
// configurazione dell'utente: vedi ai-config.js.
const aiConfig = createAiConfigStore(AI_CONFIG_FILE);

const webInfo = createWebInfoService({
  cacheFile: WEB_CACHE_FILE,
  loadAiConfig: () => aiConfig.load(),
  lmStudioBase: process.env.SOLCO_LMSTUDIO_URL || 'http://127.0.0.1:1234/v1',
  model: process.env.SOLCO_AI_MODEL || ''
});

const audioFeatures = createAudioFeatureService({ cacheDir: CACHE_DIR });
const aiPlaylist = createAiPlaylistService({ webInfo, audioFeatures });
const radioSolco = createRadioSolcoService({ webInfo });

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.oga', '.wav', '.aac', '.opus']);
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg']);
const COVER_NAMES = ['cover', 'folder', 'albumart', 'front', 'frontal', 'copertina', 'artwork', 'frontcover'];

const MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

let albumCache = null;
let albumCacheTime = 0;
let albumCacheGeneration = 0;
let scanPromise = null;
let metadataParserPromise = null;
const metadataCache = new Map();
const CACHE_TTL = 15000;
const METADATA_CACHE_MAX = 20000;
const MAX_BODY = 2 * 1024 * 1024;
let metadataIndexDirty = false;
// La 2 introduce le copertine nominate dal contenuto invece che dal percorso.
const METADATA_INDEX_VERSION = 2;
let metadataIndexVersion = METADATA_INDEX_VERSION;

function invalidateAlbumCache() {
  albumCache = null;
  albumCacheTime = 0;
  albumCacheGeneration++;
}

function coverCacheFile(name) {
  return path.join(COVER_CACHE_DIR, name);
}

// Il nome viene dal contenuto dell'immagine, non dal percorso del brano: lo stesso
// artwork occupa un file solo anche quando l'album e' indicizzato da due percorsi
// diversi (la stessa raccolta vista da Windows e da Linux) o quando i tag vengono
// riscritti e cambia la data del file.
function storeEmbeddedCover(picture) {
  try {
    const data = Buffer.from(picture.data);
    const name = crypto.createHash('sha1').update(data).digest('hex') + '.img';
    const file = coverCacheFile(name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, data);
    }
    return { name, format: picture.format || 'image/jpeg' };
  } catch (e) {
    return null;
  }
}

// Il file della copertina puo' essere condiviso con altre voci, quindi qui non si
// cancella nulla: se ne occupa la passata di pulizia all'avvio.
function forgetMetadata(key) {
  metadataCache.delete(key);
}

// Una volta sola, per le cache create prima della versione 2: rinomina i file
// secondo il contenuto e scarta le copie identiche.
function migraCopertineAContenuto() {
  let files;
  try {
    files = fs.readdirSync(COVER_CACHE_DIR);
  } catch (e) {
    return { rinominate: 0, duplicati: 0, byte: 0 };
  }
  const rinominate = new Map();
  let duplicati = 0;
  let byte = 0;
  for (const name of files) {
    if (!name.endsWith('.img')) continue;
    const file = coverCacheFile(name);
    let data;
    try {
      data = fs.readFileSync(file);
    } catch (e) {
      continue;
    }
    const nuovo = crypto.createHash('sha1').update(data).digest('hex') + '.img';
    if (nuovo === name) continue;
    try {
      if (fs.existsSync(coverCacheFile(nuovo))) {
        fs.unlinkSync(file);
        duplicati++;
        byte += data.length;
      } else {
        fs.renameSync(file, coverCacheFile(nuovo));
      }
      rinominate.set(name, nuovo);
    } catch (e) {}
  }
  if (!rinominate.size) return { rinominate: 0, duplicati: 0, byte: 0 };
  for (const entry of metadataCache.values()) {
    const picture = entry && entry.picture;
    if (picture && rinominate.has(picture.name)) picture.name = rinominate.get(picture.name);
  }
  metadataIndexDirty = true;
  return { rinominate: rinominate.size, duplicati, byte };
}

function rimuoviCopertineInutilizzate() {
  let files;
  try {
    files = fs.readdirSync(COVER_CACHE_DIR);
  } catch (e) {
    return { rimossi: 0, byte: 0 };
  }
  const usate = new Set();
  for (const entry of metadataCache.values()) {
    const picture = entry && entry.picture;
    if (picture && picture.name) usate.add(picture.name);
  }
  let rimossi = 0;
  let byte = 0;
  for (const name of files) {
    if (usate.has(name)) continue;
    try {
      byte += fs.statSync(coverCacheFile(name)).size;
      fs.unlinkSync(coverCacheFile(name));
      rimossi++;
    } catch (e) {}
  }
  return { rimossi, byte };
}

// Toglie dall'indice le voci che nessun brano potra' piu' richiamare. La regola su
// cosa sia davvero perso sta in audio-features.js ed e' la stessa usata per la
// cache dell'analisi audio, cosi' le due cache invecchiano allo stesso modo.
// La chiave dell'indice e' "percorso|dimensione|data|tipo". Il percorso puo'
// contenere '|', quindi si taglia dal fondo.
function chiaveScomposta(key) {
  const tipo = key.lastIndexOf('|');
  if (tipo <= 0) return null;
  const data = key.lastIndexOf('|', tipo - 1);
  if (data <= 0) return null;
  const dimensione = key.lastIndexOf('|', data - 1);
  if (dimensione <= 0) return null;
  return {
    file: key.slice(0, dimensione),
    size: key.slice(dimensione + 1, data),
    mtime: key.slice(data + 1, tipo)
  };
}

// Confronto testuale, non path.resolve: l'indice puo' contenere percorsi Windows
// ("D:\\Musica\\...") creati quando la stessa raccolta era montata da un altro
// sistema, e su Linux resolve() li trasformerebbe in percorsi relativi assurdi.
function percorsoDentro(file, sorgente) {
  const normalizza = (v) => String(v).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  let a = normalizza(file);
  let b = normalizza(sorgente);
  if (!b) return false;
  if (process.platform === 'win32' || /^[a-zA-Z]:/.test(b)) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a === b || a.startsWith(b + '/');
}

function vociDellaSorgente(sorgente) {
  const chiavi = [];
  for (const key of metadataCache.keys()) {
    const parti = chiaveScomposta(key);
    if (parti && percorsoDentro(parti.file, sorgente)) chiavi.push(key);
  }
  return chiavi;
}

// Toglie i dati in cache di una cartella che non si vuole piu' seguire: metadati,
// analisi audio e copertine rimaste senza riferimenti.
function dimenticaSorgente(sorgente) {
  const dentro = (file) => percorsoDentro(file, sorgente);
  const analisi = audioFeatures.dimenticaDallaCache(dentro);
  const chiavi = vociDellaSorgente(sorgente);
  if (!chiavi.length) return { voci: 0, analisi, copertine: 0, byte: 0 };
  for (const key of chiavi) metadataCache.delete(key);
  metadataIndexDirty = true;
  saveMetadataIndex();
  // Indice non salvato: i file restano dove sono, si riprovera' al prossimo avvio.
  if (metadataIndexDirty) return { voci: chiavi.length, analisi, copertine: 0, byte: 0 };
  const esito = rimuoviCopertineInutilizzate();
  return { voci: chiavi.length, analisi, copertine: esito.rimossi, byte: esito.byte };
}

function potaIndiceObsoleto() {
  let rimosse = 0;
  for (const key of [...metadataCache.keys()]) {
    const parti = chiaveScomposta(key);
    if (!parti || !vocePersa(parti.file, parti.size, parti.mtime)) continue;
    metadataCache.delete(key);
    metadataIndexDirty = true;
    rimosse++;
  }
  return rimosse;
}

// Migrazione dei nomi: va fatta all'avvio, prima di servire qualunque copertina.
function migraCacheCopertine() {
  if (metadataIndexVersion >= METADATA_INDEX_VERSION) return;
  const esito = migraCopertineAContenuto();
  metadataIndexVersion = METADATA_INDEX_VERSION;
  metadataIndexDirty = true;
  saveMetadataIndex();
  if (esito.duplicati) {
    console.log('Cache copertine: file ' + esito.rinominate + ', duplicati eliminati ' +
      esito.duplicati + ' (' + (esito.byte / 1048576).toFixed(1) + ' MB liberati)');
  }
}

// Potatura: dopo la prima scansione, quando l'indice rispecchia la libreria e i
// file appena letti sono ancora nella cache del sistema operativo.
function pulisciCache() {
  const audio = audioFeatures.potaCache();
  if (audio) console.log('Cache analisi audio: ' + audio + ' voci perse rimosse');
  const rimosse = potaIndiceObsoleto();
  saveMetadataIndex();
  // Se l'indice non e' stato salvato i nomi vivono solo in memoria: meglio non
  // toccare i file, al prossimo avvio si riprova.
  if (metadataIndexDirty) return;
  const esito = rimuoviCopertineInutilizzate();
  if (rimosse || esito.rimossi) {
    console.log('Cache: voci obsolete rimosse ' + rimosse + ', copertine inutilizzate ' +
      esito.rimossi + ' (' + (esito.byte / 1048576).toFixed(1) + ' MB liberati)');
  }
}

function loadMetadataIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (!parsed || !parsed.entries || typeof parsed.entries !== 'object') return;
    metadataIndexVersion = Number(parsed.version) || 1;
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (value && typeof value === 'object') metadataCache.set(key, value);
    }
  } catch (e) {}
}

function saveMetadataIndex() {
  if (!metadataIndexDirty) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const entries = {};
    for (const [key, value] of metadataCache) entries[key] = value;
    const tmp = INDEX_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: METADATA_INDEX_VERSION, entries }));
    fs.renameSync(tmp, INDEX_FILE);
    metadataIndexDirty = false;
  } catch (e) {
    console.error('Impossibile salvare l’indice dei metadati:', e.message);
  }
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function encodeId(rel) {
  return Buffer.from(rel).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pathKey(dir) {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// I nomi che iniziano con un punto non sono musica. In particolare i file "._x"
// sono gli stub AppleDouble che macOS lascia accanto ai file veri: stessa
// estensione, zero audio dentro. Finivano in libreria come brani fantasma (56 su
// otto album) e facevano fallire l'analisi del suono.
function nomeUtile(name) {
  return !name.startsWith('.');
}

function isAudioFile(f) {
  return f.isFile() && nomeUtile(f.name) && AUDIO_EXT.has(path.extname(f.name).toLowerCase());
}

function hasAudio(dir) {
  return listDir(dir).some(isAudioFile);
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

function folderLabel(dir) {
  return path.basename(dir) || path.resolve(dir);
}

function parseAlbumName(name) {
  const m = /^(.+?)\s*[-–—]\s*(.+?)(?:\s*[\(\[](\d{4})[\)\]])?\s*$/.exec(name);
  if (m && m[2]) {
    return { artist: m[1].trim(), title: m[2].trim(), year: m[3] ? Number(m[3]) : null };
  }
  return { artist: null, title: name, year: null };
}

function cleanTrackTitle(file) {
  let t = path.basename(file, path.extname(file));
  t = t.replace(/^\s*\d{1,3}\s*[-._)\]]\s*/, '').trim();
  return t || path.basename(file);
}

// L'estensione non garantisce niente: in libreria c'e' un "cover.jpg" da 123 KB
// che JPEG non e' (file lo riconosce come schermata curses), e veniva servito al
// browser come immagine rotta. Si guardano i primi byte e, se non tornano, si
// lascia perdere il file: l'album ripieghera' sulla copertina dentro i tag.
const FIRME_IMMAGINE = [
  [0xff, 0xd8, 0xff],                          // jpeg
  [0x89, 0x50, 0x4e, 0x47],                    // png
  [0x47, 0x49, 0x46, 0x38],                    // gif
  [0x42, 0x4d],                                // bmp
  [0x52, 0x49, 0x46, 0x46]                     // riff/webp
];

function immagineValida(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const testa = Buffer.alloc(16);
    const letti = fs.readSync(fd, testa, 0, 16, 0);
    if (!letti) return false;
    if (FIRME_IMMAGINE.some((firma) => firma.every((b, i) => testa[i] === b))) return true;
    // l'SVG e' testo: basta che cominci con un tag, a parte spazi o BOM
    const inizio = testa.slice(0, letti).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
    return inizio.startsWith('<?xml') || inizio.startsWith('<svg');
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (e) {}
    }
  }
}

function findCover(dir) {
  const files = listDir(dir)
    .filter((f) => f.isFile() && nomeUtile(f.name) && IMG_EXT.has(path.extname(f.name).toLowerCase()))
    .map((f) => f.name);
  const ordinati = [];
  for (const n of COVER_NAMES) {
    for (const f of files) {
      if (f.toLowerCase().startsWith(n) && !ordinati.includes(f)) ordinati.push(f);
    }
  }
  for (const f of files) if (!ordinati.includes(f)) ordinati.push(f);
  // il primo candidato che e' davvero un'immagine
  return ordinati.find((f) => immagineValida(path.join(dir, f))) || null;
}

function uniqueValues(values) {
  return [...new Set(values.flat().filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function firstValue(values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') || null;
}

function replayGainDb(common) {
  const candidates = [common.replaygain_album_gain, common.replaygain_track_gain];
  for (const candidate of candidates) {
    const dB = candidate && candidate.dB;
    if (Number.isFinite(dB) && dB > -60 && dB < 60) return dB;
  }
  return null;
}

function metadataYear(common) {
  if (Number.isInteger(common.year)) return common.year;
  const date = common.releasedate || common.date || common.originaldate;
  const match = date && /\b(\d{4})\b/.exec(String(date));
  return match ? Number(match[1]) : null;
}

async function metadataParser() {
  if (!metadataParserPromise) metadataParserPromise = import('music-metadata');
  return metadataParserPromise;
}

async function readTrackMetadata(file, includePicture) {
  try {
    const stat = fs.statSync(file);
    const key = pathKey(file) + '|' + stat.size + '|' + stat.mtimeMs + '|' + (includePicture ? 'cover' : 'tags');
    if (metadataCache.has(key)) {
      const hit = metadataCache.get(key);
      metadataCache.delete(key);
      metadataCache.set(key, hit);
      return hit;
    }
    const { parseFile } = await metadataParser();
    const parsed = await parseFile(file, { duration: true, skipCovers: !includePicture });
    const common = parsed.common || {};
    const format = parsed.format || {};
    const picture = includePicture && common.picture && common.picture[0]
      ? storeEmbeddedCover(common.picture[0])
      : null;
    const result = {
      album: common.album || null,
      albumArtist: common.albumartist || null,
      artist: common.artist || null,
      title: common.title || null,
      year: metadataYear(common),
      genres: common.genre || [],
      composers: common.composer || [],
      labels: common.label || [],
      catalogNumbers: common.catalognumber || [],
      releaseCountry: common.releasecountry || null,
      media: common.media || null,
      copyright: common.copyright || null,
      trackNo: common.track && common.track.no || null,
      trackTotal: common.track && common.track.of || null,
      discNo: common.disk && common.disk.no || null,
      discTotal: common.disk && common.disk.of || null,
      duration: Number.isFinite(format.duration) ? format.duration : null,
      bitrate: Number.isFinite(format.bitrate) ? format.bitrate : null,
      sampleRate: Number.isFinite(format.sampleRate) ? format.sampleRate : null,
      bitsPerSample: Number.isFinite(format.bitsPerSample) ? format.bitsPerSample : null,
      channels: Number.isFinite(format.numberOfChannels) ? format.numberOfChannels : null,
      codec: format.codec || null,
      container: format.container || null,
      lossless: typeof format.lossless === 'boolean' ? format.lossless : null,
      gain: replayGainDb(common),
      picture
    };
    metadataCache.set(key, result);
    metadataIndexDirty = true;
    while (metadataCache.size > METADATA_CACHE_MAX) {
      forgetMetadata(metadataCache.keys().next().value);
    }
    return result;
  } catch (e) {
    return null;
  }
}

async function makeAlbum(dir, parentArtist) {
  const absoluteDir = path.resolve(dir);
  const local = isInside(absoluteDir, MUSIC_DIR);
  const rel = local ? path.relative(MUSIC_DIR, absoluteDir).split(path.sep).join('/') : null;
  const parsed = parseAlbumName(folderLabel(dir));
  const audio = listDir(dir)
    .filter(isAudioFile)
    .map((f) => f.name)
    .sort(naturalCompare);
  if (!audio.length) return null;

  const taggedTracks = [];
  for (let index = 0; index < audio.length; index++) {
    const file = audio[index];
    const metadata = await readTrackMetadata(path.join(absoluteDir, file), index === 0);
    taggedTracks.push({ file, metadata });
  }
  taggedTracks.sort((a, b) => {
    const ad = a.metadata && a.metadata.discNo || 1;
    const bd = b.metadata && b.metadata.discNo || 1;
    if (ad !== bd) return ad - bd;
    const at = a.metadata && a.metadata.trackNo;
    const bt = b.metadata && b.metadata.trackNo;
    if (at && bt && at !== bt) return at - bt;
    return naturalCompare(a.file, b.file);
  });

  const metadataItems = taggedTracks.map((track) => track.metadata).filter(Boolean);
  const albumArtist = firstValue(metadataItems.map((item) => item.albumArtist));
  const trackArtist = firstValue(metadataItems.map((item) => item.artist));
  const artist = albumArtist || trackArtist || parsed.artist || parentArtist || 'Artista sconosciuto';
  const title = firstValue(metadataItems.map((item) => item.album)) || parsed.title || folderLabel(dir);
  const year = firstValue(metadataItems.map((item) => item.year)) || parsed.year;
  const genres = uniqueValues(metadataItems.map((item) => item.genres));
  const composers = uniqueValues(metadataItems.map((item) => item.composers));
  const labels = uniqueValues(metadataItems.map((item) => item.labels));
  const catalogNumbers = uniqueValues(metadataItems.map((item) => item.catalogNumbers));
  const formats = uniqueValues(metadataItems.map((item) => item.codec || item.container));
  const gains = metadataItems.map((item) => item.gain).filter(Number.isFinite);
  const durations = metadataItems.map((item) => item.duration).filter(Number.isFinite);
  const bitrates = metadataItems.map((item) => item.bitrate).filter(Number.isFinite);
  const embeddedCover = metadataItems.map((item) => item.picture).find(Boolean) || null;
  const coverFile = findCover(dir);
  let addedAt = null;
  try {
    addedAt = fs.statSync(absoluteDir).mtimeMs;
  } catch (e) {}
  const album = {
    id: local
      ? encodeId(rel)
      : 'ext-' + crypto.createHash('sha256').update(pathKey(absoluteDir)).digest('hex').slice(0, 32),
    artist,
    title,
    year,
    external: !local,
    genre: genres,
    genreManual: false,
    composer: composers,
    label: labels,
    catalogNumber: catalogNumbers,
    releaseCountry: firstValue(metadataItems.map((item) => item.releaseCountry)),
    media: firstValue(metadataItems.map((item) => item.media)),
    copyright: firstValue(metadataItems.map((item) => item.copyright)),
    duration: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
    formats,
    bitrate: bitrates.length ? Math.round(bitrates.reduce((sum, value) => sum + value, 0) / bitrates.length) : null,
    sampleRate: firstValue(metadataItems.map((item) => item.sampleRate)),
    bitsPerSample: firstValue(metadataItems.map((item) => item.bitsPerSample)),
    channels: firstValue(metadataItems.map((item) => item.channels)),
    discCount: metadataItems.reduce((max, item) => Math.max(max, item.discTotal || item.discNo || 1), 1),
    lossless: metadataItems.length > 0 && metadataItems.every((item) => item.lossless === true),
    gain: gains.length ? gains[0] : null,
    addedAt,
    cover: !!coverFile || !!embeddedCover,
    coverFile,
    tracks: taggedTracks.map((track, i) => {
      const metadata = track.metadata || {};
      return {
        i,
        file: track.file,
        title: metadata.title || cleanTrackTitle(track.file),
        artist: metadata.artist || null,
        trackNo: metadata.trackNo || null,
        trackTotal: metadata.trackTotal || null,
        discNo: metadata.discNo || null,
        discTotal: metadata.discTotal || null,
        duration: metadata.duration || null,
        codec: metadata.codec || metadata.container || null,
        bitrate: metadata.bitrate || null,
        sampleRate: metadata.sampleRate || null,
        bitsPerSample: metadata.bitsPerSample || null,
        gain: Number.isFinite(metadata.gain) ? metadata.gain : null
      };
    })
  };
  Object.defineProperty(album, 'dir', { value: absoluteDir, enumerable: false });
  Object.defineProperty(album, 'embeddedCover', { value: embeddedCover, enumerable: false });
  return album;
}

async function discoverAlbums(root, external) {
  const albums = [];
  const sourceRoot = path.resolve(root);

  async function visit(dir, depth) {
    if (depth > 12) return;
    if (hasAudio(dir)) {
      const parent = path.dirname(dir);
      const parentArtist = !external && path.resolve(parent) === sourceRoot
        ? null
        : path.basename(parent);
      const album = await makeAlbum(dir, parentArtist);
      if (album) albums.push(album);
    }
    for (const entry of listDir(dir)) {
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), depth + 1);
    }
  }

  await visit(sourceRoot, 0);
  return albums;
}

function loadSources() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
    return Array.isArray(parsed.sources)
      ? parsed.sources.filter((source) => typeof source === 'string' && source.trim())
      : [];
  } catch (e) {
    return [];
  }
}

function saveSources(sources) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify({ sources }, null, 2));
}

function loadAlbumOverrides() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ALBUM_OVERRIDES_FILE, 'utf8'));
    return parsed && typeof parsed.albums === 'object' && parsed.albums ? parsed.albums : {};
  } catch (e) {
    return {};
  }
}

function saveAlbumOverrides(albums) {
  fs.writeFileSync(ALBUM_OVERRIDES_FILE, JSON.stringify({ albums }, null, 2));
}

async function scan(force) {
  if (!force && albumCache && Date.now() - albumCacheTime < CACHE_TTL) return albumCache;
  if (scanPromise) {
    const inFlight = scanPromise;
    if (!force) return inFlight;
    return inFlight.then(() => scan(true), () => scan(true));
  }
  scanPromise = (async () => {
    const generation = albumCacheGeneration;
    if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
    const byId = new Map();
    const addAlbums = (items) => {
      for (const album of items) {
        if (!byId.has(album.id)) byId.set(album.id, album);
      }
    };

    addAlbums(await discoverAlbums(MUSIC_DIR, false));
    for (const source of loadSources()) {
      try {
        if (fs.statSync(source).isDirectory()) {
          addAlbums(await discoverAlbums(source, true));
        }
      } catch (e) {}
    }

    const albums = [...byId.values()];
    const overrides = loadAlbumOverrides();
    for (const album of albums) {
      const override = overrides[album.id];
      if (override && Array.isArray(override.genre)) {
        album.genre = uniqueValues(override.genre);
        album.genreManual = true;
      }
    }
    albums.sort(
      (a, b) =>
        a.artist.localeCompare(b.artist, undefined, { numeric: true }) ||
        a.title.localeCompare(b.title, undefined, { numeric: true })
    );
    if (generation === albumCacheGeneration) {
      albumCache = albums;
      albumCacheTime = Date.now();
    }
    saveMetadataIndex();
    return albums;
  })();
  try {
    return await scanPromise;
  } finally {
    scanPromise = null;
  }
}

async function findAlbum(id) {
  const wanted = String(id || '');
  if (!wanted) return null;
  if (albumCache) {
    const hit = albumCache.find((album) => album.id === wanted);
    if (hit) return hit;
  }
  return (await scan()).find((album) => album.id === wanted) || null;
}

function loadPlaylists() {
  try {
    return JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8')).playlists || [];
  } catch (e) {
    return [];
  }
}

function savePlaylists(lists) {
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify({ playlists: lists }, null, 2));
}

function loadRadioEpisodes() {
  try {
    return JSON.parse(fs.readFileSync(RADIO_FILE, 'utf8')).episodes || [];
  } catch (e) {
    return [];
  }
}

function saveRadioEpisodes(episodes) {
  fs.writeFileSync(RADIO_FILE, JSON.stringify({ episodes }, null, 2));
}

function uuid() {
  return crypto.randomBytes(8).toString('hex');
}

/* ---- testi dei brani (.lrc e tag incorporati) ---- */

const lyricsCache = new Map();
const LYRICS_CACHE_MAX = 300;
const LRC_STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

function readTextFile(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^﻿/, '');
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1');
  return text.replace(/^﻿/, '');
}

function parseLrc(source) {
  const lines = [];
  let offset = 0;
  for (const raw of String(source).split(/\r?\n/)) {
    const line = raw.trim();
    const offsetTag = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(line);
    if (offsetTag) {
      offset = Number(offsetTag[1]) / 1000;
      continue;
    }
    LRC_STAMP.lastIndex = 0;
    const stamps = [];
    let end = 0;
    let match;
    while ((match = LRC_STAMP.exec(line)) !== null) {
      if (match.index !== end) break;
      end = LRC_STAMP.lastIndex;
      const frac = match[3] ? Number('0.' + match[3]) : 0;
      stamps.push(Number(match[1]) * 60 + Number(match[2]) + frac);
    }
    if (!stamps.length) continue;
    const text = line.slice(end).trim();
    for (const time of stamps) lines.push({ time, text });
  }
  return lines
    .map((item) => ({ time: Math.max(0, item.time - offset), text: item.text }))
    .sort((a, b) => a.time - b.time);
}

function findLrcFile(dir, trackFile) {
  const base = path.basename(trackFile, path.extname(trackFile)).toLowerCase();
  const hit = listDir(dir)
    .filter((f) => f.isFile() && path.extname(f.name).toLowerCase() === '.lrc')
    .map((f) => f.name)
    .find((name) => path.basename(name, path.extname(name)).toLowerCase() === base);
  return hit ? path.join(dir, hit) : null;
}

async function embeddedLyrics(file) {
  try {
    const stat = fs.statSync(file);
    const key = pathKey(file) + '|' + stat.size + '|' + stat.mtimeMs;
    if (lyricsCache.has(key)) return lyricsCache.get(key);
    const { parseFile } = await metadataParser();
    const parsed = await parseFile(file, { duration: false, skipCovers: true });
    const tags = (parsed.common && parsed.common.lyrics) || [];
    let result = null;
    for (const tag of tags) {
      const sync = Array.isArray(tag.syncText) ? tag.syncText : [];
      // timeStampFormat 2 = millisecondi; gli altri formati non sono convertibili
      if (tag.timeStampFormat === 2 && sync.some((item) => Number.isFinite(item.timestamp))) {
        result = {
          synced: true,
          lines: sync
            .filter((item) => Number.isFinite(item.timestamp))
            .map((item) => ({ time: item.timestamp / 1000, text: String(item.text || '').trim() }))
            .sort((a, b) => a.time - b.time)
        };
        break;
      }
      const plain = tag.text || sync.map((item) => item.text).join('');
      if (plain && plain.trim() && !result) {
        result = { synced: false, lines: plain.split(/\r?\n/).map((text) => ({ time: null, text: text.trim() })) };
      }
    }
    if (lyricsCache.size >= LYRICS_CACHE_MAX) lyricsCache.delete(lyricsCache.keys().next().value);
    lyricsCache.set(key, result);
    return result;
  } catch (e) {
    return null;
  }
}

async function handleLyrics(res, q) {
  const album = await findAlbum(q.id);
  if (!album) return json(res, 404, { error: 'Album non trovato' });
  const track = album.tracks.find((t) => String(t.i) === String(q.i));
  if (!track) return json(res, 404, { error: 'Brano non trovato' });

  const lrcFile = findLrcFile(album.dir, track.file);
  if (lrcFile) {
    try {
      const lines = parseLrc(readTextFile(lrcFile));
      if (lines.length) {
        return json(res, 200, { source: path.basename(lrcFile), synced: true, lines });
      }
    } catch (e) {}
  }

  const embedded = await embeddedLyrics(path.join(album.dir, track.file));
  if (embedded && embedded.lines.length) {
    return json(res, 200, { source: 'tag incorporati', synced: embedded.synced, lines: embedded.lines });
  }
  return json(res, 404, { error: 'Nessun testo disponibile per questo brano' });
}

/* ---- statistiche d'ascolto e preferiti ---- */

const STATS_ALBUM_MAX = 5000;
const STATS_TRACK_MAX = 20000;

function validAlbumId(value) {
  const id = String(value || '');
  return id && id.length <= 200 && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

function loadStats() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    return {
      albums: parsed && parsed.albums && typeof parsed.albums === 'object' ? parsed.albums : {},
      tracks: parsed && parsed.tracks && typeof parsed.tracks === 'object' ? parsed.tracks : {}
    };
  } catch (e) {
    return { albums: {}, tracks: {} };
  }
}

function pruneStats(stats) {
  const trim = (map, max, keep) => {
    const all = Object.keys(map);
    if (all.length <= max) return;
    all
      .filter((key) => !keep || !keep(map[key]))
      .sort((a, b) => (map[a].lastPlayed || 0) - (map[b].lastPlayed || 0))
      .slice(0, all.length - max)
      .forEach((key) => delete map[key]);
  };
  trim(stats.albums, STATS_ALBUM_MAX, (entry) => entry && entry.favorite);
  trim(stats.tracks, STATS_TRACK_MAX, null);
}

function saveStats(stats) {
  pruneStats(stats);
  const tmp = STATS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
  fs.renameSync(tmp, STATS_FILE);
}

function albumStatsEntry(stats, albumId) {
  if (!stats.albums[albumId]) stats.albums[albumId] = { plays: 0, lastPlayed: 0, favorite: false };
  return stats.albums[albumId];
}

function json(res, code, obj) {
  if (res.writableEnded) return;
  if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Solo corpi dichiarati JSON: un modulo HTML cross-origin puo' inviare
    // text/plain o form-urlencoded senza preflight, application/json no.
    const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ctype && ctype !== 'application/json') {
      reject(httpError('Serve Content-Type: application/json', 415));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (message, statusCode) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(httpError(message, statusCode));
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        fail('Richiesta troppo grande', 413);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw && !ctype) {
        reject(httpError('Serve Content-Type: application/json', 415));
        return;
      }
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(httpError('Corpo della richiesta non è JSON valido', 400));
      }
    });
    req.on('error', (e) => fail(e.message, 400));
    req.on('aborted', () => fail('Richiesta interrotta dal client', 400));
  });
}

// Invia un file al client. Usiamo pipeline e non pipe perche' pipe non chiude la
// sorgente quando il browser abbandona la risposta: con le richieste Range annullate
// a ogni seek o cambio brano i descrittori di file restavano aperti fino al GC.
function sendFile(res, file, opts) {
  const stream = fs.createReadStream(file, opts);
  pipeline(stream, res, (err) => {
    if (err && !res.writableEnded) res.end();
  });
}

async function handleStream(req, res, q) {
  if (!q.id) return json(res, 400, { error: 'id album mancante' });
  const album = await findAlbum(q.id);
  if (!album) return json(res, 404, { error: 'Album non trovato' });
  const track = album.tracks.find((t) => String(t.i) === String(q.i));
  if (!track) return json(res, 404, { error: 'Brano non trovato' });
  const file = path.join(album.dir, track.file);
  if (!fs.existsSync(file)) return json(res, 404, { error: 'File non trovato' });
  const stat = fs.statSync(file);
  const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const total = stat.size;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');

  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': total });
    return res.end();
  }

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    let start;
    let end;

    if (!m || (!m[1] && !m[2]) || total === 0) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      return res.end();
    }

    if (!m[1]) {
      const suffixLength = Number(m[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total });
        return res.end();
      }
      start = Math.max(total - suffixLength, 0);
      end = total - 1;
    } else {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : total - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total });
        return res.end();
      }
      end = Math.min(end, total - 1);
    }

    if (start < 0 || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      return res.end();
    }

    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total
    });
    sendFile(res, file, { start, end });
  } else {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': total });
    sendFile(res, file);
  }
}

async function handleCover(req, res, q) {
  const album = await findAlbum(q.id);
  let file = null;
  let mime = null;
  if (album && album.coverFile) {
    file = path.join(album.dir, album.coverFile);
    mime = MIME[path.extname(file).toLowerCase()] || 'image/jpeg';
  } else if (album && album.embeddedCover) {
    file = coverCacheFile(album.embeddedCover.name);
    mime = album.embeddedCover.format || 'image/jpeg';
  }
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }

  const stat = fs.statSync(file);
  const etag = '"' + stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'max-age=86400' });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': 'max-age=86400',
    ETag: etag
  });
  sendFile(res, file);
}

function serveStatic(req, res, p) {
  let decoded;
  try {
    decoded = decodeURIComponent(p);
  } catch (e) {
    res.writeHead(400);
    return res.end();
  }
  if (decoded.includes('\0')) {
    res.writeHead(400);
    return res.end();
  }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/public\//, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('Non trovato');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  sendFile(res, file);
}

function validateRel(rel) {
  if (!rel || typeof rel !== 'string') return null;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.length > 64) return null;
  for (const p of parts) {
    if (p === '..' || p === '.') return null;
    if (p.length > 200) return null;
    if (/[<>:"|?*\x00-\x1f]/.test(p)) return null;
  }
  return parts;
}

function listDrives() {
  const drives = [];
  if (process.platform === 'win32') {
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      try {
        fs.accessSync(letter + ':\\');
        drives.push({ label: letter + ':', path: letter + ':\\' });
      } catch (e) {}
    }
  } else {
    drives.push({ label: '/', path: '/' });
  }
  return drives;
}

function defaultDir() {
  if (process.platform === 'win32') {
    const d = listDrives();
    return d.length ? d[0].path : 'C:\\';
  }
  return require('os').homedir();
}

async function handleImportPath(req, res, body) {
  let src = String(body.path || '').trim();
  if (!src) return json(res, 400, { error: 'Percorso richiesto' });
  if (process.platform === 'win32' && /^[a-zA-Z]:$/.test(src)) src += '\\';
  if (!fs.existsSync(src)) return json(res, 404, { error: 'Percorso non trovato' });
  if (!fs.statSync(src).isDirectory()) return json(res, 400, { error: 'Non è una cartella' });
  src = fs.realpathSync(src);
  if (isInside(src, MUSIC_DIR)) {
    return json(res, 400, { error: 'Questa cartella è già gestita dalla raccolta locale music/' });
  }

  const indexed = await discoverAlbums(src, true);
  if (!indexed.length) {
    return json(res, 400, { error: 'Nessuna cartella album con file audio trovata qui' });
  }

  const sources = loadSources();
  const alreadyRegistered = sources.some((source) => pathKey(source) === pathKey(src));
  if (!alreadyRegistered) {
    sources.push(src);
    saveSources(sources);
  }
  invalidateAlbumCache();
  return json(res, 200, {
    source: src,
    alreadyRegistered,
    indexed: indexed.map((album) => ({ artist: album.artist, title: album.title })),
    count: indexed.length
  });
}

function handleUpload(req, res, q) {
  const parts = validateRel(q.rel);
  if (!parts) return json(res, 400, { error: 'Percorso non valido' });
  const file = path.join(MUSIC_DIR, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file);
  req.pipe(out);
  out.on('finish', () => {
    invalidateAlbumCache();
    json(res, 200, { ok: true, file: parts.join('/') });
  });
  out.on('error', (err) => {
    req.destroy();
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  });
  req.on('error', () => {
    out.destroy();
  });
}

// Difesa dalle pagine aperte nel browser. Ascoltare solo su 127.0.0.1 non basta:
// un sito qualunque puo' inviare all'app richieste "semplici" (indicizzare cartelle,
// caricare file in music/, consumare crediti OpenRouter) e, con il DNS rebinding,
// leggerne anche le risposte. Controlliamo quindi Host e Origin a ogni richiesta.
function hostnameIsLocal(name) {
  const h = String(name || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return EXTRA_HOSTS.has(h);
}

function hostHeaderIsLocal(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return false;
    const rest = raw.slice(close + 1);
    if (rest && !/^:\d+$/.test(rest)) return false;
    return hostnameIsLocal(raw.slice(1, close));
  }
  const parts = raw.split(':');
  if (parts.length > 2) return false;
  if (parts.length === 2 && !/^\d+$/.test(parts[1])) return false;
  return hostnameIsLocal(parts[0]);
}

// Le GET "semplici" (<img>, <script>, link) non portano l'header Origin, quindi il
// controllo sotto non le vede: una pagina qualunque poteva chiamare, per esempio,
// /api/web/artist?refresh=1 e consumare crediti OpenRouter. I browser moderni
// mandano pero' Sec-Fetch-Site, e per le API si accetta solo la nostra pagina
// (same-origin) o l'indirizzo digitato a mano (none). "same-site" resta fuori:
// il sito ignora la porta, e un'altra app su localhost non e' Solco. Senza
// l'header (curl, browser vecchi) si ricade sui controlli di Host e Origin.
function fetchSiteIsLocal(req) {
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

function requestIsLocal(req) {
  if (!hostHeaderIsLocal(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  // "null" e' l'origine di un iframe in sandbox: non e' la nostra pagina.
  if (origin === 'null') return false;
  try {
    return hostnameIsLocal(new URL(origin).hostname);
  } catch (e) {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  if (!requestIsLocal(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Richiesta non locale');
  }
  // Un percorso come "//" o "//[" non e' un URL valido: senza il try l'eccezione
  // usciva dal gestore e faceva terminare l'intero processo.
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Richiesta non valida');
  }
  const p = u.pathname;
  // Sul percorso gia' normalizzato: "/./api/..." diventa "/api/...".
  if (p.startsWith('/api/') && !fetchSiteIsLocal(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Richiesta non locale');
  }
  const q = Object.fromEntries(u.searchParams);
  try {
    if (p === '/api/albums') {
      const force = q.force === '1' || q.force === 'true';
      return json(res, 200, { albums: await scan(force) });
    }
    if (p === '/api/web/album' && req.method === 'GET') {
      const album = await findAlbum(q.id);
      if (!album) return json(res, 404, { error: 'Album non trovato' });
      try {
        return json(res, 200, await webInfo.albumInfo(album, q.refresh === '1'));
      } catch (err) {
        return json(res, 502, { error: 'Ricerca web non riuscita: ' + err.message });
      }
    }
    if (p === '/api/web/artist' && req.method === 'GET') {
      const name = String(q.name || '').trim();
      if (!name) return json(res, 400, { error: 'Nome artista mancante' });
      if (name.length > 200) return json(res, 400, { error: 'Nome artista troppo lungo' });
      try {
        return json(res, 200, await webInfo.artistInfo(name, q.refresh === '1'));
      } catch (err) {
        return json(res, 502, { error: 'Ricerca web non riuscita: ' + err.message });
      }
    }
    if (p === '/api/ai/status' && req.method === 'GET') {
      return json(res, 200, await webInfo.aiStatus());
    }
    if (p === '/api/ai/config') {
      if (req.method === 'GET') {
        const cfg = aiConfig.load();
        return json(res, 200, {
          provider: cfg.provider,
          openRouterModel: cfg.openRouterModel,
          hasOpenRouterKey: !!cfg.openRouterKey,
          keyFromEnv: cfg.keyFromEnv,
          keyFile: aiConfig.secretsFile
        });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const provider = body.provider === 'openrouter' ? 'openrouter' : 'lmstudio';
        const openRouterModel = String(body.openRouterModel || '').trim().slice(0, 200);
        const newKey = String(body.openRouterKey || '').trim();
        if (newKey.length > 300) return json(res, 400, { error: 'Chiave API troppo lunga' });
        // una chiave vuota nel corpo significa "non toccarla": l'utente non deve
        // reinserirla ogni volta che cambia solo provider o modello.
        const saved = aiConfig.save({ provider, openRouterModel, openRouterKey: newKey });
        return json(res, 200, {
          ok: true,
          provider: saved.provider,
          openRouterModel: saved.openRouterModel,
          hasOpenRouterKey: !!saved.openRouterKey,
          keyFromEnv: saved.keyFromEnv,
          keyFile: aiConfig.secretsFile
        });
      }
      res.writeHead(405);
      return res.end();
    }
    if (p === '/api/ai/verify' && req.method === 'POST') {
      const body = await readBody(req);
      const apiKey = String(body.apiKey || '').trim() || aiConfig.load().openRouterKey;
      return json(res, 200, await webInfo.verifyOpenRouterKey(apiKey));
    }
    if (p === '/api/ai/models' && req.method === 'GET') {
      try {
        return json(res, 200, { models: await webInfo.listOpenRouterModels() });
      } catch (err) {
        return json(res, 502, { error: 'Impossibile ottenere l\'elenco dei modelli: ' + err.message });
      }
    }
    if (p === '/api/audio-analysis/status' && req.method === 'GET') {
      const albums = await scan();
      const brani = [];
      for (const a of albums) for (const t of a.tracks) brani.push({ file: path.join(a.dir, t.file) });
      return json(res, 200, { ...audioFeatures.statoAnalisi(), braniTotali: brani.length, daAnalizzare: audioFeatures.quantiMancano(brani) });
    }
    if (p === '/api/audio-analysis/start' && req.method === 'POST') {
      const albums = await scan();
      const brani = [];
      for (const a of albums) {
        for (const t of a.tracks) {
          brani.push({ file: path.join(a.dir, t.file), durata: t.duration, titolo: a.artist + ' — ' + t.title });
        }
      }
      const esito = await audioFeatures.avviaAnalisi(brani);
      if (!esito.ok) return json(res, 409, esito);
      return json(res, 200, esito);
    }
    if (p === '/api/audio-analysis/stop' && req.method === 'POST') {
      return json(res, 200, audioFeatures.fermaAnalisi());
    }
    if (p === '/api/ai/playlist' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await aiPlaylist.plan(await scan(), String(body.prompt || ''));
      if (!result.ok) return json(res, 422, result);
      return json(res, 200, result);
    }
    if (p === '/api/radio/episodes' && req.method === 'GET') {
      return json(res, 200, { episodes: loadRadioEpisodes() });
    }
    if (p === '/api/radio/options' && req.method === 'GET') {
      // aiAvailable serve al menu: il tema scritto dall'utente e' l'unico taglio
      // che senza modello linguistico non si puo' fare.
      const stato = await webInfo.aiStatus();
      return json(res, 200, {
        ...radioSolco.opzioni(await scan()),
        aiAvailable: !!stato.available,
        aiMessage: stato.message || ''
      });
    }
    if (p === '/api/radio/episode' && req.method === 'POST') {
      const body = await readBody(req);
      const saved = loadRadioEpisodes();
      // Il corpo e' facoltativo: senza, il taglio lo sceglie il modello.
      const richiesta = body && body.mode
        ? {
          mode: String(body.mode),
          theme: body.theme == null ? null : String(body.theme).trim().slice(0, 200),
          genre: body.genre == null ? null : String(body.genre).slice(0, 120),
          yearMin: Number.isFinite(Number(body.yearMin)) ? Math.round(Number(body.yearMin)) : null,
          yearMax: Number.isFinite(Number(body.yearMax)) ? Math.round(Number(body.yearMax)) : null
        }
        : null;
      if (richiesta && richiesta.mode === 'theme' && !richiesta.theme) {
        return json(res, 400, { error: 'Scrivi il tema della puntata' });
      }
      const result = await radioSolco.produce(await scan(), {
        request: richiesta,
        avoidSignatures: saved.map((e) => e.signature).filter(Boolean),
        avoidTitles: saved.slice(0, 12).map((e) => e.title).filter(Boolean)
      });
      if (!result.ok) return json(res, 422, result);
      const episode = {
        id: uuid(),
        createdAt: Date.now(),
        playCount: 0,
        lastPlayedAt: 0,
        ...result.episode
      };
      saved.unshift(episode);
      // la cronologia delle puntate non cresce all'infinito
      saveRadioEpisodes(saved.slice(0, 100));
      return json(res, 201, { episode });
    }
    if (p === '/api/radio/episodes' && req.method === 'DELETE') {
      const all = loadRadioEpisodes();
      const kept = all.filter((e) => e.id !== q.id);
      if (kept.length === all.length) return json(res, 404, { error: 'Puntata non trovata' });
      saveRadioEpisodes(kept);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/radio/episode-played' && req.method === 'PUT') {
      const body = await readBody(req);
      const all = loadRadioEpisodes();
      const ep = all.find((e) => e.id === body.id);
      if (!ep) return json(res, 404, { error: 'Puntata non trovata' });
      ep.playCount = (ep.playCount || 0) + 1;
      ep.lastPlayedAt = Date.now();
      saveRadioEpisodes(all);
      return json(res, 200, { ok: true, episode: ep });
    }
    if (p === '/api/album-metadata') {
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const albumId = String(body.albumId || '');
        const album = await findAlbum(albumId);
        if (!album) return json(res, 404, { error: 'Album non trovato' });
        const rawGenre = String(body.genre || '');
        if (rawGenre.length > 500) return json(res, 400, { error: 'Genere troppo lungo' });
        const genre = uniqueValues(rawGenre.split(/[,;]+/)).slice(0, 20);
        const overrides = loadAlbumOverrides();
        overrides[albumId] = { ...(overrides[albumId] || {}), genre };
        saveAlbumOverrides(overrides);
        invalidateAlbumCache();
        return json(res, 200, { ok: true, genre });
      }
      if (req.method === 'DELETE') {
        const albumId = String(q.id || '');
        const overrides = loadAlbumOverrides();
        if (Object.prototype.hasOwnProperty.call(overrides, albumId)) {
          delete overrides[albumId];
          saveAlbumOverrides(overrides);
        }
        invalidateAlbumCache();
        return json(res, 200, { ok: true });
      }
      res.writeHead(405);
      return res.end();
    }
    if (p === '/api/sources') {
      if (req.method === 'GET') {
        const sources = loadSources().map((source) => ({
          path: source,
          available: fs.existsSync(source),
          cachedTracks: vociDellaSorgente(source).length,
          cachedFeatures: audioFeatures.contaCache((file) => percorsoDentro(file, source))
        }));
        return json(res, 200, { sources });
      }
      if (req.method === 'DELETE') {
        const target = String(q.path || '');
        const forget = q.forget === '1' || q.forget === 'true';
        const sources = loadSources();
        const filtered = sources.filter((source) => pathKey(source) !== pathKey(target));
        if (filtered.length === sources.length) {
          return json(res, 404, { error: 'Cartella indicizzata non trovata' });
        }
        saveSources(filtered);
        invalidateAlbumCache();
        // Senza forget la cartella esce solo dall'elenco e i metadati restano in
        // cache: reinserirla e' immediato. Con forget si buttano anche quelli.
        const dimenticato = forget
          ? dimenticaSorgente(target)
          : { voci: 0, analisi: 0, copertine: 0, byte: 0 };
        return json(res, 200, { ok: true, forgotten: forget, ...dimenticato });
      }
      res.writeHead(405);
      return res.end();
    }
    if (p === '/api/lyrics') {
      if (req.method === 'GET') return await handleLyrics(res, q);
      res.writeHead(405);
      return res.end();
    }
    if (p === '/api/stats') {
      if (req.method === 'GET') return json(res, 200, loadStats());
      res.writeHead(405);
      return res.end();
    }
    if (p === '/api/stats/play') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const albumId = validAlbumId(body.albumId);
        if (!albumId) return json(res, 400, { error: 'Album non valido' });
        const stats = loadStats();
        const now = Date.now();
        const album = albumStatsEntry(stats, albumId);
        album.plays = (album.plays || 0) + 1;
        album.lastPlayed = now;
        const index = Number(body.index);
        if (Number.isInteger(index) && index >= 0 && index < 10000) {
          const key = albumId + '|' + index;
          const track = stats.tracks[key] || { plays: 0, lastPlayed: 0 };
          track.plays = (track.plays || 0) + 1;
          track.lastPlayed = now;
          stats.tracks[key] = track;
        }
        saveStats(stats);
        return json(res, 200, { ok: true, album });
      }
      res.writeHead(405);
      return res.end();
    }
    if (p === '/api/stats/favorite') {
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const albumId = validAlbumId(body.albumId);
        if (!albumId) return json(res, 400, { error: 'Album non valido' });
        const stats = loadStats();
        const album = albumStatsEntry(stats, albumId);
        album.favorite = !!body.favorite;
        saveStats(stats);
        return json(res, 200, { ok: true, album });
      }
      res.writeHead(405);
      return res.end();
    }
    if (p === '/api/drives') {
      return json(res, 200, { drives: listDrives() });
    }
    if (p === '/api/dirs') {
      let dir = q.path ? path.normalize(String(q.path)) : defaultDir();
      if (process.platform === 'win32' && /^[a-zA-Z]:$/.test(dir)) dir += '\\';
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return json(res, 400, { error: 'Cartella non trovata' });
      }
      const parent = path.dirname(dir);
      const dirs = listDir(dir)
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(naturalCompare)
        .map((name) => {
          const d = path.join(dir, name);
          const audioCount = listDir(d).filter(isAudioFile).length;
          return { name, album: audioCount > 0, audioCount };
        });
      return json(res, 200, { path: dir, parent: parent !== dir ? parent : null, dirs });
    }
    if (p === '/api/import-path' && req.method === 'POST') {
      return await handleImportPath(req, res, await readBody(req));
    }
    if (p === '/api/upload' && req.method === 'POST') {
      return handleUpload(req, res, q);
    }
    if (p === '/api/stream') {
      return await handleStream(req, res, q);
    }
    if (p === '/api/cover') {
      return await handleCover(req, res, q);
    }
    if (p === '/api/playlists') {
      if (req.method === 'GET') return json(res, 200, { playlists: loadPlaylists() });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!name) return json(res, 400, { error: 'Nome richiesto' });
        const lists = loadPlaylists();
        const pl = { id: uuid(), name, tracks: [] };
        lists.push(pl);
        savePlaylists(lists);
        return json(res, 201, pl);
      }
      if (req.method === 'DELETE') {
        const all = loadPlaylists();
        const lists = all.filter((x) => x.id !== q.id);
        if (lists.length === all.length) {
          return json(res, 404, { error: 'Playlist non trovata' });
        }
        savePlaylists(lists);
        return json(res, 200, { ok: true });
      }
      res.writeHead(405);
      return res.end();
    }
    if (p === '/api/playlist-tracks') {
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const lists = loadPlaylists();
        const pl = lists.find((x) => x.id === body.playlistId);
        if (!pl) return json(res, 404, { error: 'Playlist non trovata' });

        if (Array.isArray(body.tracks)) {
          if (body.tracks.length > 500) return json(res, 400, { error: 'Troppi brani in una sola richiesta' });
          const albumCacheLocal = new Map();
          let added = 0;
          for (const ref of body.tracks) {
            const albumId = String((ref && ref.albumId) || '');
            if (!albumId) continue;
            let album = albumCacheLocal.get(albumId);
            if (album === undefined) {
              album = await findAlbum(albumId);
              albumCacheLocal.set(albumId, album || null);
            }
            if (!album) continue;
            const t = album.tracks.find((x) => String(x.i) === String(ref.index));
            if (!t) continue;
            if (pl.tracks.some((x) => x.albumId === album.id && x.index === t.i)) continue;
            pl.tracks.push({
              albumId: album.id,
              index: t.i,
              title: t.title,
              artist: album.artist,
              album: album.title,
              year: album.year,
              cover: album.cover
            });
            added++;
          }
          savePlaylists(lists);
          return json(res, 200, { ...pl, added });
        }

        const album = await findAlbum(body.albumId);
        if (!album) return json(res, 404, { error: 'Album non trovato' });
        const entries = body.index === undefined || body.index === null
          ? album.tracks
          : album.tracks.filter((t) => String(t.i) === String(body.index));
        for (const t of entries) {
          const entry = {
            albumId: album.id,
            index: t.i,
            title: t.title,
            artist: album.artist,
            album: album.title,
            year: album.year,
            cover: album.cover
          };
          if (!pl.tracks.some((x) => x.albumId === album.id && x.index === t.i)) {
            pl.tracks.push(entry);
          }
        }
        savePlaylists(lists);
        return json(res, 200, pl);
      }
      if (req.method === 'DELETE') {
        const body = await readBody(req);
        const lists = loadPlaylists();
        const pl = lists.find((x) => x.id === body.playlistId);
        if (!pl) return json(res, 404, { error: 'Playlist non trovata' });
        const position = Number(body.position);
        if (!Number.isInteger(position) || position < 0 || position >= pl.tracks.length) {
          return json(res, 400, { error: 'Posizione del brano non valida' });
        }
        pl.tracks.splice(position, 1);
        savePlaylists(lists);
        return json(res, 200, pl);
      }
      res.writeHead(405);
      return res.end();
    }
    if (p === '/' || p.startsWith('/public/')) {
      return serveStatic(req, res, p);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Non trovato');
  } catch (err) {
    const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    if (status >= 500) console.error(err);
    if (res.writableEnded) return;
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: status >= 500 ? 'Errore interno: ' + err.message : err.message }));
  }
});

loadMetadataIndex();
migraCacheCopertine();

try {
  const esito = aiConfig.migrate();
  if (esito.moved) console.log('Chiave OpenRouter spostata in ' + esito.file + ' (rimossa da ai-config.json)');
} catch (err) {
  console.error('Impossibile spostare la chiave OpenRouter:', err.message);
}

server.listen(PORT, HOST, async () => {
  try {
    const started = Date.now();
    const known = metadataCache.size;
    const n = (await scan()).length;
    pulisciCache();
    console.log('Solco attivo su http://' + HOST + ':' + PORT);
    console.log('Album trovati nelle cartelle indicizzate: ' + n +
      ' (indicizzazione in ' + ((Date.now() - started) / 1000).toFixed(1) + 's' +
      ', ' + known + ' brani già in cache)');
  } catch (err) {
    console.error('Errore durante l’indicizzazione iniziale:', err);
  }
});
