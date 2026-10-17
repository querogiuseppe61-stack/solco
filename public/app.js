'use strict';

(() => {

const state = {
  albums: [],
  playlists: [],
  queue: [],
  pos: -1,
  shuffle: false,
  repeat: 0,
  current: null,
  modalTarget: null,
  genreAlbumId: null,
  searchTracks: [],
  isSeeking: false,
  volume: 0.8,
  gain: null,
  stats: { albums: {}, tracks: {} },
  sort: 'artist',
  genreFilter: '',
  playCounted: false,
  lyrics: { key: null, synced: false, lines: [], active: -1 },
  aiPlaylistDraft: null,
  openRouterModels: [],
  radioEpisodes: [],
  radioBusy: false,
  radioOpen: new Set(),
  radioOptions: null,
  radioChoice: { mode: 'auto', genre: '', decade: '', yearMin: '', yearMax: '', theme: '' },
  radioError: ''
};

const audio = new Audio();
audio.preload = 'metadata';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SVG = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.7-9.5-8.7C.8 8.9 2.6 5 6.2 5c2 0 3.3 1.1 4 2 .7-.9 2-2 4-2 3.6 0 5.4 3.9 3.7 7.3C19.5 16.3 12 21 12 21z"/></svg>',
  heartOff: '<svg viewBox="0 0 24 24"><path d="M12 20.3l-.9-.8C5.6 14.5 2.5 11.7 2.5 8.5 2.5 6 4.4 4 6.9 4c1.5 0 2.9.7 3.8 1.8h.6C12.2 4.7 13.6 4 15.1 4c2.5 0 4.4 2 4.4 4.5 0 3.2-3.1 6-8.6 11l-.9.8zm0-2.1c4.7-4.3 7.5-6.8 7.5-9.7 0-1.7-1.2-2.9-2.9-2.9-1.2 0-2.4.7-3 1.9h-3.2c-.6-1.2-1.8-1.9-3-1.9-1.7 0-2.9 1.2-2.9 2.9 0 2.9 2.8 5.4 7.5 9.7z"/></svg>'
};

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
};

function hashHue(id) {
  let h = 0;
  for (const c of String(id || 'x')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function placeholderArt(album) {
  const initials = (album.artist || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const hue = hashHue(album.id || album.albumId);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="hsl(' + hue + ',55%,30%)"/>' +
    '<stop offset="1" stop-color="hsl(' + ((hue + 40) % 360) + ',60%,16%)"/>' +
    '</linearGradient></defs>' +
    '<rect width="600" height="600" fill="url(#g)"/>' +
    '<text x="300" y="330" font-family="Arial,sans-serif" font-size="170" font-weight="bold" fill="rgba(255,255,255,.9)" text-anchor="middle">' + esc(initials) + '</text></svg>';
  // L'apostrofo resta scoperto con encodeURIComponent, e l'URL finisce anche dentro
  // onerror="this.src='...'": un artista come "'Til Tuesday" spezzava la stringa.
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg).replace(/'/g, '%27');
}

function coverHtml(album, cls) {
  const id = album.albumId || album.id;
  if (album.cover) {
    return '<div class="cover ' + (cls || '') + '"><img src="/api/cover?id=' + encodeURIComponent(id) + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=\'' + placeholderArt(album) + '\'"></div>';
  }
  return '<div class="cover ' + (cls || '') + ' ph"><img src="' + placeholderArt(album) + '" alt=""></div>';
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const t = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(t.error || 'Errore ' + r.status);
  return t;
}

function safeWebUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch (e) {
    return null;
  }
}

function webLink(url, label, className) {
  const safe = safeWebUrl(url);
  if (!safe) return '';
  return '<a class="' + (className || 'web-link') + '" href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>';
}

function webSources(items) {
  const links = (items || []).map((source) => webLink(source.url, source.label)).filter(Boolean);
  return links.length ? '<div class="source-links"><span>Fonti</span>' + links.join('') + '</div>' : '';
}

function summaryHtml(text) {
  const parts = String(text || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return parts.map((part) => '<p>' + esc(part) + '</p>').join('');
}

function aiBadge(ai) {
  if (ai && ai.used) {
    return '<span class="web-badge ai-on">' + esc(ai.provider || 'AI locale') + ' · ' + esc(ai.model || 'modello locale') + '</span>';
  }
  return '<span class="web-badge">Fonti aperte</span>';
}

function renderAlbumWebInfo(data, albumId) {
  const match = data.match || {};
  const facts = [
    ['Prima pubblicazione', match.firstReleaseDate],
    ['Tipo', [match.primaryType].concat(match.secondaryTypes || []).filter(Boolean).join(' · ')],
    ['Generi', (match.genres || []).join(', ')],
    ['Edizioni censite', match.editions],
    ['Nota', match.disambiguation]
  ].filter((item) => item[1] !== undefined && item[1] !== null && item[1] !== '');
  return '<div class="web-head"><div><h2>Approfondimento dal web</h2>' + aiBadge(data.ai) + '</div>' +
    '<button class="btn ghost small" data-refresh-album-web="' + encodeURIComponent(albumId) + '">Aggiorna</button></div>' +
    (data.summary ? '<div class="web-summary">' + summaryHtml(data.summary) + '</div>' : '') +
    (facts.length ? '<div class="web-facts">' + facts.map((item) =>
      '<div class="web-fact"><span>' + esc(item[0]) + '</span><strong>' + esc(item[1]) + '</strong></div>'
    ).join('') + '</div>' : '') +
    (data.ai && !data.ai.used ? '<div class="web-warning">' + esc(data.ai.message || 'AI locale non attiva') + '</div>' : '') +
    webSources(data.sources);
}

async function loadAlbumWebInfo(albumId, refresh) {
  const box = document.querySelector('#albumWebInfo');
  if (!box || box.dataset.album !== encodeURIComponent(albumId)) return;
  box.classList.remove('hidden');
  box.innerHTML = '<div class="web-loading"><span class="web-spinner"></span>Ricerca nelle fonti aperte in corso…</div>';
  try {
    const query = '/api/web/album?id=' + encodeURIComponent(albumId) + (refresh ? '&refresh=1' : '');
    const data = await api(query);
    const current = document.querySelector('#albumWebInfo');
    if (current && current.dataset.album === encodeURIComponent(albumId)) current.innerHTML = renderAlbumWebInfo(data, albumId);
  } catch (err) {
    const current = document.querySelector('#albumWebInfo');
    if (current && current.dataset.album === encodeURIComponent(albumId)) {
      current.innerHTML = '<div class="web-error"><strong>Informazioni non disponibili</strong><p>' + esc(err.message) + '</p>' +
        '<button class="btn ghost small" data-refresh-album-web="' + encodeURIComponent(albumId) + '">Riprova</button></div>';
    }
  }
}

function renderArtistWebInfo(data, artistName) {
  const life = data.lifeSpan || {};
  const facts = [
    ['Tipo', data.type],
    ['Paese', data.country],
    ['Area', data.area],
    ['Origine', data.beginArea],
    ['Attività', [life.begin, life.end || (life.ended === false ? 'in attività' : '')].filter(Boolean).join(' – ')],
    ['Generi', (data.genres || []).join(', ')],
    ['Nota', data.disambiguation]
  ].filter((item) => item[1]);
  const items = data.discography && data.discography.items || [];
  const discography = items.length
    ? '<div class="discography-list">' + items.map((item) => {
        const type = [item.primaryType].concat(item.secondaryTypes || []).filter(Boolean).join(' · ');
        const title = safeWebUrl(item.url) ? webLink(item.url, item.title, 'discography-title') : '<strong>' + esc(item.title) + '</strong>';
        return '<div class="discography-row"><time>' + esc(item.year || '—') + '</time><div>' + title +
          (item.disambiguation ? '<small>' + esc(item.disambiguation) + '</small>' : '') + '</div><span>' + esc(type) + '</span></div>';
      }).join('') + '</div>'
    : '<p class="web-muted">Nessuna pubblicazione trovata.</p>';
  const total = data.discography && data.discography.total || items.length;
  const complete = !data.discography || data.discography.complete;
  return '<div class="web-head"><div><h2>Profilo dell’artista</h2>' + aiBadge(data.ai) + '</div>' +
    '<button class="btn ghost small" data-refresh-artist-web="' + encodeURIComponent(artistName) + '">Aggiorna</button></div>' +
    '<div class="artist-web-hero">' +
    (safeWebUrl(data.image) ? '<img class="artist-photo" src="' + esc(safeWebUrl(data.image)) + '" alt="' + esc(data.name || artistName) + '">' : '') +
    '<div class="artist-web-copy">' +
    (data.biography ? '<div class="web-summary">' + summaryHtml(data.biography) + '</div>' : '<p class="web-muted">Biografia non disponibile.</p>') +
    (facts.length ? '<div class="web-facts">' + facts.map((item) => '<div class="web-fact"><span>' + esc(item[0]) + '</span><strong>' + esc(item[1]) + '</strong></div>').join('') + '</div>' : '') +
    (data.officialSite ? '<div class="official-site">' + webLink(data.officialSite, 'Sito ufficiale') + '</div>' : '') +
    '</div></div>' +
    (data.ai && !data.ai.used ? '<div class="web-warning">' + esc(data.ai.message || 'AI locale non attiva') + '</div>' : '') +
    webSources(data.sources) +
    '<div class="discography-head"><h2>Discografia completa</h2><span>' +
    (total || complete ? esc(total) + ' pubblicazioni' + (complete ? '' : ' · prime ' + items.length) : 'Nessuna corrispondenza certa') +
    '</span></div>' + discography;
}

async function loadArtistWebInfo(artistName, refresh) {
  const expected = encodeURIComponent(artistName);
  const box = document.querySelector('#artistWebInfo');
  if (!box || box.dataset.artist !== expected) return;
  box.innerHTML = '<div class="web-loading"><span class="web-spinner"></span>Recupero biografia e discografia completa…</div>';
  try {
    const query = '/api/web/artist?name=' + encodeURIComponent(artistName) + (refresh ? '&refresh=1' : '');
    const data = await api(query);
    const current = document.querySelector('#artistWebInfo');
    if (current && current.dataset.artist === expected) current.innerHTML = renderArtistWebInfo(data, artistName);
  } catch (err) {
    const current = document.querySelector('#artistWebInfo');
    if (current && current.dataset.artist === expected) {
      current.innerHTML = '<div class="web-error"><strong>Profilo web non disponibile</strong><p>' + esc(err.message) + '</p>' +
        '<button class="btn ghost small" data-refresh-artist-web="' + expected + '">Riprova</button></div>';
    }
  }
}

/* ---------------- API helpers ---------------- */

function albumById(id) {
  return state.albums.find((a) => a.id === id);
}

/* ---------------- Statistiche d'ascolto ---------------- */

function albumStats(id) {
  return state.stats.albums[id] || { plays: 0, lastPlayed: 0, favorite: false };
}

function isFavorite(id) {
  return !!albumStats(id).favorite;
}

async function countPlay(entry) {
  try {
    const r = await api('/api/stats/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumId: entry.albumId, index: entry.index })
    });
    state.stats.albums[entry.albumId] = r.album;
  } catch (e) {}
}

async function toggleFavorite(albumId) {
  try {
    const r = await api('/api/stats/favorite', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumId, favorite: !isFavorite(albumId) })
    });
    state.stats.albums[albumId] = r.album;
    router();
    toast(r.album.favorite ? 'Aggiunto ai preferiti' : 'Rimosso dai preferiti');
  } catch (err) {
    toast(err.message);
  }
}

function sortedAlbums(list) {
  const arr = list.slice();
  const byArtist = (a, b) =>
    a.artist.localeCompare(b.artist, 'it', { numeric: true }) ||
    a.title.localeCompare(b.title, 'it', { numeric: true });
  if (state.sort === 'title') return arr.sort((a, b) => a.title.localeCompare(b.title, 'it', { numeric: true }));
  if (state.sort === 'year') return arr.sort((a, b) => (b.year || 0) - (a.year || 0) || byArtist(a, b));
  if (state.sort === 'added') return arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || byArtist(a, b));
  if (state.sort === 'plays') return arr.sort((a, b) => albumStats(b.id).plays - albumStats(a.id).plays || byArtist(a, b));
  return arr.sort(byArtist);
}

function allGenres() {
  const set = new Set();
  for (const album of state.albums) for (const g of album.genre || []) set.add(g);
  return [...set].sort((a, b) => a.localeCompare(b, 'it'));
}

function libraryControls() {
  const sorts = [
    ['artist', 'Artista'],
    ['title', 'Titolo'],
    ['year', 'Anno (dal più recente)'],
    ['added', 'Aggiunti di recente'],
    ['plays', 'Più ascoltati']
  ];
  const genres = allGenres();
  return '<div class="lib-controls">' +
    '<label>Ordina per <select id="sortSelect">' + sorts.map(([value, label]) =>
      '<option value="' + value + '"' + (state.sort === value ? ' selected' : '') + '>' + esc(label) + '</option>'
    ).join('') + '</select></label>' +
    (genres.length
      ? '<label>Genere <select id="genreSelect"><option value="">Tutti</option>' + genres.map((g) =>
          '<option value="' + esc(g) + '"' + (state.genreFilter === g ? ' selected' : '') + '>' + esc(g) + '</option>'
        ).join('') + '</select></label>'
      : '') +
    '</div>';
}

function strip(title, albums) {
  return '<h2 class="section-title">' + esc(title) + '</h2>' +
    '<div class="strip">' + albums.map(albumCard).join('') + '</div>';
}

function entryFor(album, t) {
  return {
    albumId: album.id,
    index: t.i,
    title: t.title,
    artist: album.artist,
    album: album.title,
    year: album.year,
    cover: album.cover
  };
}

/* ---------------- Playback ---------------- */

/* Normalizzazione ReplayGain: il volume dell'elemento audio è il volume scelto
   dall'utente moltiplicato per il guadagno dichiarato nei tag del brano. */
function applyVolume() {
  const factor = Number.isFinite(state.gain) ? Math.pow(10, state.gain / 20) : 1;
  audio.volume = Math.max(0, Math.min(1, state.volume * factor));
}

function gainFor(entry) {
  const album = albumById(entry.albumId);
  const track = album && album.tracks.find((t) => t.i === entry.index);
  if (track && Number.isFinite(track.gain)) return track.gain;
  return album && Number.isFinite(album.gain) ? album.gain : null;
}

function playAt(idx) {
  if (!state.queue.length) return;
  if (idx < 0) idx = 0;
  if (idx >= state.queue.length) idx = 0;
  state.pos = idx;
  state.current = state.queue[idx];
  state.gain = gainFor(state.current);
  state.playCounted = false;
  applyVolume();
  audio.src = '/api/stream?id=' + encodeURIComponent(state.current.albumId) + '&i=' + state.current.index;
  audio.play().catch(() => {});
  updatePlayerUI();
  const panel = $('#queuePanel');
  if (panel && !panel.classList.contains('hidden')) renderQueuePanel();
  loadLyrics(false);
}

function playAlbumTracks(album, startIdx, shuffleStart) {
  if (!album) return;
  state.queue = album.tracks.map((t) => entryFor(album, t));
  if (shuffleStart && state.shuffle && state.queue.length > 1) {
    playAt(Math.floor(Math.random() * state.queue.length));
  } else {
    playAt(startIdx || 0);
  }
}

function playEntries(entries, idx) {
  state.queue = entries.slice();
  playAt(idx || 0);
}

function togglePlay() {
  if (!state.current) {
    if (state.queue.length) playAt(state.pos >= 0 ? state.pos : 0);
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
  updatePlayerUI();
}

function pickNext() {
  if (!state.queue.length) return -1;
  if (state.shuffle && state.queue.length > 1) {
    let r;
    do {
      r = Math.floor(Math.random() * state.queue.length);
    } while (r === state.pos);
    return r;
  }
  return state.pos + 1;
}

function nextTrack() {
  if (!state.queue.length) return;
  const n = pickNext();
  if (n >= state.queue.length) {
    if (state.repeat === 1) {
      playAt(0);
    } else {
      state.pos = -1;
      state.current = null;
      audio.pause();
      audio.removeAttribute('src');
      updatePlayerUI();
    }
    return;
  }
  playAt(n);
}

function prevTrack() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  playAt(state.pos - 1 >= 0 ? state.pos - 1 : 0);
}

function addToQueue(album, startIdx) {
  if (!album) return;
  const entries = album.tracks.map((t) => entryFor(album, t));
  if (!state.queue.length) {
    state.queue = entries;
    playAt(startIdx || 0);
    toast('Riproduzione avviata');
    return;
  }
  state.queue.push(...entries);
  toast('Aggiunti ' + entries.length + ' brani alla coda');
  renderQueuePanel();
}

/* ---------------- Player UI ---------------- */

function updatePlayerUI() {
  const cur = state.current;
  $('#nowCover').innerHTML = cur ? coverHtml(cur, 'small') : '';
  $('#nowTitle').textContent = cur ? cur.title : 'Nessun brano in riproduzione';
  $('#nowArtist').textContent = cur ? cur.artist + (cur.album ? ' — ' + cur.album : '') : '';
  $('#playIcon').innerHTML = cur && !audio.paused ? SVG.pause : SVG.play;
  $('#shuffleBtn').classList.toggle('active', state.shuffle);
  $('#repeatBtn').classList.toggle('active', state.repeat > 0);
  $('#repeatBtn').title = state.repeat === 2 ? 'Ripeti: 1 brano' : state.repeat === 1 ? 'Ripeti: tutto' : 'Ripeti: off';
  document.title = cur ? cur.title + ' — ' + cur.artist + ' — Solco' : 'Solco';
  markCurrent();
  refreshRadioOnAir();
  if ('mediaSession' in navigator && cur) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cur.title,
      artist: cur.artist,
      album: cur.album,
      artwork: [{ src: cur.cover ? '/api/cover?id=' + encodeURIComponent(cur.albumId) : placeholderArt(cur), sizes: '600x600' }]
    });
  }
}

function markCurrent() {
  document.querySelectorAll('.track').forEach((el) => {
    const isCur = state.current &&
      el.dataset.album === state.current.albumId &&
      +el.dataset.i === state.current.index;
    el.classList.toggle('playing', !!isCur);
  });
}

/* ---------------- Sidebar ---------------- */

function renderPlaylists() {
  const ul = $('#playlistList');
  if (!state.playlists.length) {
    ul.innerHTML = '<li class="pl-item" style="color:#666;cursor:default;">Nessuna playlist</li>';
    return;
  }
  ul.innerHTML = state.playlists.map((p) =>
    '<li class="pl-item" data-playlist-link="' + p.id + '">' +
    '<span class="pl-name">' + esc(p.name) + '</span>' +
    '<span class="pl-count">' + p.tracks.length + '</span>' +
    '<button class="pl-del" data-del-playlist="' + p.id + '" title="Elimina playlist">' + SVG.trash + '</button>' +
    '</li>'
  ).join('');
}

/* ---------------- Views ---------------- */

function albumCard(a) {
  return '<div class="card" data-album-link="' + encodeURIComponent(a.id) + '">' +
    '<div class="cover-wrap">' + coverHtml(a) +
    (isFavorite(a.id) ? '<span class="card-fav" title="Nei preferiti">' + SVG.heart + '</span>' : '') +
    '<button class="card-play" data-quickplay="' + encodeURIComponent(a.id) + '" title="Riproduci album">' + SVG.play + '</button></div>' +
    '<div class="card-title" title="' + esc(a.title) + '">' + esc(a.title) + '</div>' +
    '<div class="card-sub" data-artist-link="' + encodeURIComponent(a.artist) + '">' + esc(a.artist) + (a.year ? ' · ' + esc(a.year) : '') + '</div>' +
    '</div>';
}

function fmtAlbumDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return Math.round(seconds) + ' sec';
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? hours + ' h ' + String(minutes).padStart(2, '0') + ' min' : totalMinutes + ' min';
}

function albumSheet(a) {
  const facts = [];
  const add = (label, value, kind) => {
    if (value !== undefined && value !== null && value !== '') facts.push([label, value, kind]);
  };
  add('Genere', a.genre && a.genre.length ? a.genre.join(', ') : 'Non specificato', 'genre');
  add('Durata', fmtAlbumDuration(a.duration));
  add('Formato', a.formats && a.formats.join(', '));
  const quality = [
    a.bitsPerSample ? a.bitsPerSample + ' bit' : '',
    a.sampleRate ? (a.sampleRate / 1000).toFixed(a.sampleRate % 1000 ? 1 : 0) + ' kHz' : '',
    a.bitrate ? Math.round(a.bitrate / 1000) + ' kbps' : ''
  ].filter(Boolean).join(' · ');
  add('Qualità audio', quality);
  add('Canali', a.channels === 1 ? 'Mono' : a.channels === 2 ? 'Stereo' : a.channels);
  add('Normalizzazione', Number.isFinite(a.gain)
    ? 'ReplayGain ' + (a.gain > 0 ? '+' : '') + a.gain.toFixed(1) + ' dB'
    : '');
  add('Dischi', a.discCount > 1 ? a.discCount : '');
  add('Supporto', a.media);
  add('Compositore', a.composer && a.composer.join(', '));
  add('Etichetta', a.label && a.label.join(', '));
  add('Catalogo', a.catalogNumber && a.catalogNumber.join(', '));
  add('Paese', a.releaseCountry);
  add('Copyright', a.copyright);
  if (!facts.length) return '';
  return '<section class="album-sheet"><h2 class="section-title">Informazioni album</h2>' +
    '<div class="album-meta">' + facts.map(([label, value, kind]) =>
      kind === 'genre'
        ? '<div class="meta-card genre-meta"><span>' + esc(label) + '</span>' +
          '<div class="meta-value-row"><strong>' + esc(value) + '</strong>' +
          '<button class="meta-edit" data-edit-genre="' + encodeURIComponent(a.id) + '">Modifica</button></div>' +
          (a.genreManual ? '<em>Inserito manualmente</em>' : '') + '</div>'
        : '<div class="meta-card"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>'
    ).join('') + '</div></section>';
}

function trackRow(t, album, opts) {
  const showRm = opts && opts.rm;
  const ext = t.codec || t.file.split('.').pop().toUpperCase();
  const number = t.trackNo || (t.i + 1);
  const numberLabel = album.discCount > 1 && t.discNo ? t.discNo + '.' + String(number).padStart(2, '0') : number;
  const details = [ext, t.duration ? fmt(t.duration) : ''].filter(Boolean).join(' · ');
  const trackArtist = t.artist && t.artist !== album.artist
    ? '<small>' + esc(t.artist) + '</small>'
    : '';
  return '<div class="track" data-album="' + album.id + '" data-i="' + t.i + '">' +
    '<span class="t-idx">' + numberLabel + '</span>' +
    '<span class="t-title">' + esc(t.title) + trackArtist + '</span>' +
    '<span class="t-ext">' + esc(details) + '</span>' +
    (showRm
      ? '<button class="mini-btn rm-btn" data-rm-playlist="' + esc(showRm) + '" data-pos="' + opts.pos + '" title="Rimuovi dalla playlist">' + SVG.trash + '</button>'
      : '<button class="mini-btn add-btn" data-add-to-pl title="Aggiungi a playlist">' + SVG.plus + '</button>') +
    '</div>';
}

function renderHome() {
  const v = $('#view');
  if (!state.albums.length) {
    v.innerHTML = '<div class="empty"><div class="big">' + SVG.play + '</div><h2>La tua biblioteca è vuota</h2>' +
      '<p>Indicizza la cartella del drive che contiene i tuoi album.<br>I file resteranno nella loro posizione originale.</p>' +
      '<p>La copertina si chiama <code>cover.jpg</code> (o folder.jpg, front.jpg...).</p>' +
      '<button class="btn" onclick="document.querySelector(\'#importBtn\').click()">Indicizza musica</button></div>';
    return;
  }
  const artistCount = new Set(state.albums.map((a) => a.artist)).size;
  const recent = state.albums
    .filter((a) => albumStats(a.id).lastPlayed)
    .sort((a, b) => albumStats(b.id).lastPlayed - albumStats(a.id).lastPlayed)
    .slice(0, 8);
  const top = state.albums
    .filter((a) => albumStats(a.id).plays > 0)
    .sort((a, b) => albumStats(b.id).plays - albumStats(a.id).plays)
    .slice(0, 8);
  const filtered = state.genreFilter
    ? state.albums.filter((a) => (a.genre || []).includes(state.genreFilter))
    : state.albums;
  const list = sortedAlbums(filtered);

  let html = '<h1 class="view-title">Home</h1>' +
    '<div class="view-sub">' + state.albums.length + ' album · ' + artistCount + ' artisti</div>';
  if (recent.length) html += strip('Ascoltati di recente', recent);
  if (top.length > 1) html += strip('Più ascoltati', top);
  html += '<div class="lib-head"><h2 class="section-title">Tutti gli album</h2>' + libraryControls() + '</div>';
  html += list.length
    ? '<div class="grid">' + list.map(albumCard).join('') + '</div>'
    : '<div class="empty"><h2>Nessun album con il genere "' + esc(state.genreFilter) + '"</h2></div>';
  v.innerHTML = html;
}

function renderFavorites() {
  const v = $('#view');
  const list = sortedAlbums(state.albums.filter((a) => isFavorite(a.id)));
  if (!list.length) {
    v.innerHTML = '<h1 class="view-title">Preferiti</h1>' +
      '<div class="empty"><div class="big">' + SVG.heart + '</div><h2>Nessun preferito</h2>' +
      '<p>Apri un album e usa il cuore per aggiungerlo qui.</p></div>';
    return;
  }
  v.innerHTML = '<h1 class="view-title">Preferiti</h1>' +
    '<div class="view-sub">' + list.length + ' album</div>' +
    '<div class="grid">' + list.map(albumCard).join('') + '</div>';
}

/* ---------------- Radio Solco ---------------- */

const RADIO_MODE_LABEL = {
  random: 'Pescata libera',
  genre: 'Monografica di genere',
  decade: 'Un decennio',
  years: 'Un periodo',
  mixed: 'Filo conduttore libero'
};

function fmtEpisodeLength(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const m = Math.round(seconds / 60);
  return m + ' min';
}

function radioEpisodeEntries(ep) {
  return ep.tracks.map((t) => ({
    albumId: t.albumId,
    index: t.index,
    title: t.title,
    artist: t.artist,
    album: t.album,
    year: t.year,
    cover: t.cover,
    radioId: ep.id
  }));
}

// Una puntata e' "in onda" finche' il brano corrente appartiene alla sua scaletta.
function isRadioOnAir(id) {
  return !!(state.current && state.current.radioId === id);
}

function radioMetaText(ep) {
  const when = ep.createdAt
    ? new Date(ep.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  const meta = [
    ep.criteriaLabel || RADIO_MODE_LABEL[ep.mode] || 'Puntata',
    ep.trackCount + ' brani',
    fmtEpisodeLength(ep.totalSeconds)
  ].filter(Boolean).join(' · ');
  return meta + (when ? ' · ' + when : '') +
    (ep.playCount ? ' · riascoltata ' + ep.playCount + (ep.playCount === 1 ? ' volta' : ' volte') : '');
}

function radioPlayLabel(onAir) {
  return onAir ? 'In onda' : 'Manda in onda';
}

// Aggiorna pulsanti e schede senza ridisegnare la vista: cosi' non si perdono
// le schede aperte ne' i campi del modulo "taglio della puntata".
function refreshRadioOnAir() {
  document.querySelectorAll('[data-radio-card]').forEach((card) => {
    const on = isRadioOnAir(card.dataset.radioCard);
    card.classList.toggle('on-air', on);
    const btn = card.querySelector('[data-radio-play]');
    if (btn) {
      btn.classList.toggle('on-air', on);
      btn.textContent = radioPlayLabel(on);
    }
  });
}

// Come la puntata e' stata messa insieme: chi ha deciso il taglio, quale taglio,
// con quali parole il server ha filtrato i candidati e quanti ne ha agganciati.
function radioEpisodeCriteria(ep) {
  const c = ep.criteria || {};
  const righe = [];
  const riga = (et, valore) => righe.push('<dt>' + esc(et) + '</dt><dd>' + valore + '</dd>');

  riga('Scelto da', ep.chosenBy === 'utente' ? 'te' : 'l\u2019IA');
  riga('Taglio', esc(RADIO_MODE_LABEL[ep.mode] || ep.mode || 'Puntata'));
  if (c.genre) riga('Genere', esc(c.genre));
  if (c.yearMin) {
    riga('Periodo', esc(c.yearMax && c.yearMax !== c.yearMin ? c.yearMin + '\u2013' + c.yearMax : String(c.yearMin)));
  }
  if (ep.requestedTheme) riga('Tema chiesto', esc(ep.requestedTheme));
  if (c.keywords && c.keywords.length) {
    riga('Parole cercate', '<span class="parole">' +
      c.keywords.map((k) => '<span class="parola">' + esc(k) + '</span>').join('') + '</span>');
  }
  if (Number.isFinite(ep.themeMatches)) {
    // e' il numero di candidati che hanno agganciato le parole, non dei brani
    // finiti in scaletta: da li' il modello ha scelto i suoi
    riga('Agganci', ep.themeMatches + (ep.themeMatches === 1 ? ' brano' : ' brani') +
      ' della libreria, fra cui il modello ha scelto i ' + ep.trackCount + ' trasmessi');
  }
  if (ep.motivo) riga('Perch\u00e9', esc(ep.motivo));
  return '<dl class="radio-crit hidden" data-radio-crit-box="' + esc(ep.id) + '">' + righe.join('') + '</dl>';
}

function radioEpisodeCard(ep) {
  const open = state.radioOpen.has(ep.id);
  const onAir = isRadioOnAir(ep.id);
  const warnings = (ep.warnings || []).length
    ? '<div class="web-warning">' + ep.warnings.map((w) => esc(w)).join('<br>') + '</div>'
    : '';
  const tracks = ep.tracks.map((t, i) =>
    '<div class="track" data-album="' + esc(t.albumId) + '" data-i="' + t.index + '" data-radio-ep="' + esc(ep.id) + '" data-radio-pos="' + i + '">' +
    '<span class="t-idx">' + (i + 1) + '</span>' +
    '<span class="t-title">' + esc(t.title) + ' <span style="color:#666;">· ' + esc(t.artist) + ' — ' + esc(t.album) + '</span></span>' +
    '<span class="t-ext">' + (t.duration ? esc(fmt(t.duration)) : '') + '</span>' +
    '</div>'
  ).join('');
  return '<div class="radio-ep' + (open ? ' open' : '') + (onAir ? ' on-air' : '') + '" data-radio-card="' + esc(ep.id) + '">' +
    '<div class="radio-ep-head" data-radio-expand="' + esc(ep.id) + '" role="button" tabindex="0" aria-expanded="' + open + '" title="Mostra o nascondi i dettagli">' +
    '<span class="radio-ep-chev"><svg viewBox="0 0 24 24"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg></span>' +
    '<h3>' + esc(ep.title) + '</h3>' +
    '<button class="btn radio-play' + (onAir ? ' on-air' : '') + '" data-radio-play="' + esc(ep.id) + '">' + radioPlayLabel(onAir) + '</button>' +
    '</div>' +
    '<div class="radio-ep-body' + (open ? '' : ' hidden') + '">' +
    '<span class="radio-ep-badge">' + esc(RADIO_MODE_LABEL[ep.mode] || 'Puntata') + '</span>' +
    '<div class="radio-ep-meta" data-radio-meta="' + esc(ep.id) + '">' + esc(radioMetaText(ep)) + '</div>' +
    (ep.requestedTheme ? '<p class="radio-ep-theme">Tema richiesto: ' + esc(ep.requestedTheme) + '</p>' : '') +
    (ep.description ? '<p class="radio-ep-desc">' + esc(ep.description) + '</p>' : '') +
    (ep.ai && ep.ai.used
      ? '<span class="web-badge ai-on">Curata da ' + esc(ep.ai.provider || 'IA') + (ep.ai.model ? ' · ' + esc(ep.ai.model) : '') + '</span>'
      : '<span class="web-badge">Montata dal server</span>') +
    warnings +
    '<div class="radio-ep-actions">' +
    '<button class="btn ghost" data-radio-queue="' + esc(ep.id) + '">In coda</button>' +
    '<button class="btn ghost" data-radio-save="' + esc(ep.id) + '">Salva come playlist</button>' +
    '<button class="btn ghost" data-radio-del="' + esc(ep.id) + '" title="Elimina puntata">' + SVG.trash + '</button>' +
    '</div>' +
    '<button class="radio-ep-toggle" data-radio-crit="' + esc(ep.id) + '">Mostra i criteri</button>' +
    radioEpisodeCriteria(ep) +
    '<button class="radio-ep-toggle" data-radio-toggle="' + esc(ep.id) + '">Mostra la scaletta</button>' +
    '<div class="radio-ep-tracks tracklist hidden">' + tracks + '</div>' +
    '</div></div>';
}

// Trasforma una puntata in una playlist normale, riusando le API esistenti.
async function saveEpisodeAsPlaylist(id) {
  const ep = state.radioEpisodes.find((e) => e.id === id);
  if (!ep || !ep.tracks.length) return;
  const nome = (prompt('Nome della playlist:', ep.title) || '').trim();
  if (!nome) return;
  try {
    const pl = await api('/api/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nome })
    });
    const esito = await api('/api/playlist-tracks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playlistId: pl.id,
        tracks: ep.tracks.map((t) => ({ albumId: t.albumId, index: t.index }))
      })
    });
    const aggiunti = esito.added === undefined ? ep.tracks.length : esito.added;
    state.playlists = (await api('/api/playlists')).playlists;
    renderPlaylists();
    toast('Playlist "' + nome + '" creata con ' + aggiunti + (aggiunti === 1 ? ' brano' : ' brani'));
  } catch (err) {
    toast('Non riuscito: ' + err.message);
  }
}

function toggleRadioCard(id) {
  const card = document.querySelector('[data-radio-card="' + CSS.escape(id) + '"]');
  if (!card) return;
  const open = card.classList.toggle('open');
  if (open) state.radioOpen.add(id); else state.radioOpen.delete(id);
  const body = card.querySelector('.radio-ep-body');
  if (body) body.classList.toggle('hidden', !open);
  const head = card.querySelector('[data-radio-expand]');
  if (head) head.setAttribute('aria-expanded', String(open));
}

function renderRadioCut() {
  const opt = state.radioOptions;
  const c = state.radioChoice;
  const modi = [
    ['auto', 'Lascia decidere all\u2019IA'],
    ['random', 'Pescata libera'],
    ['genre', 'Un genere'],
    ['decade', 'Un decennio'],
    ['years', 'Un periodo'],
    ['theme', 'Un tema mio']
  ];
  let html = '<label>Taglio della puntata<select id="radioMode">' +
    modi.map(([v, t]) => '<option value="' + v + '"' + (c.mode === v ? ' selected' : '') + '>' + esc(t) + '</option>').join('') +
    '</select></label>';

  if (!opt) return html + '<span class="hint">Lettura della libreria\u2026</span>';

  if (c.mode === 'genre') {
    html += '<label>Genere<select id="radioGenre">' +
      opt.genres.map((g) => '<option value="' + esc(g.nome) + '"' + (c.genre === g.nome ? ' selected' : '') + '>' +
        esc(g.nome) + ' (' + g.brani + ')</option>').join('') +
      '</select></label>';
  }
  if (c.mode === 'decade') {
    html += '<label>Decennio<select id="radioDecade">' +
      opt.decades.map((d) => '<option value="' + d.decade + '"' + (String(c.decade) === String(d.decade) ? ' selected' : '') + '>' +
        esc(d.label) + ' (' + d.brani + ')</option>').join('') +
      '</select></label>';
  }
  if (c.mode === 'theme') {
    // L'unico taglio che senza modello non si puo' fare: il tema arriva in
    // italiano e i titoli sono in inglese, serve qualcuno che faccia il salto.
    html += '<label class="tema">Tema' +
      '<input id="radioTheme" type="text" maxlength="200" placeholder="canzoni per guidare di notte"' +
      ' value="' + esc(c.theme) + '"' + (opt.aiAvailable ? '' : ' disabled') + '></label>';
    if (!opt.aiAvailable) {
      html += '<span class="hint">Serve il modello linguistico' +
        (opt.aiMessage ? ': ' + esc(opt.aiMessage.toLowerCase()) : '') + '</span>';
    }
  }
  if (c.mode === 'years') {
    html += '<label class="anni">Periodo' +
      '<input id="radioYearMin" type="number" inputmode="numeric" placeholder="' + (opt.yearMin || 1900) + '" value="' + esc(c.yearMin) + '">' +
      '<input id="radioYearMax" type="number" inputmode="numeric" placeholder="' + (opt.yearMax || '') + '" value="' + esc(c.yearMax) + '">' +
      '</label>';
  }
  return html;
}

// Il taglio richiesto al server, o null per lasciar decidere al modello.
function radioRequest() {
  const c = state.radioChoice;
  if (c.mode === 'auto') return null;
  if (c.mode === 'random') return { mode: 'random' };
  if (c.mode === 'theme') {
    const tema = String(c.theme || '').trim();
    if (!tema) {
      toast('Scrivi il tema della puntata');
      return false;
    }
    return { mode: 'theme', theme: tema };
  }
  if (c.mode === 'genre') {
    const genre = c.genre || (state.radioOptions && state.radioOptions.genres[0] && state.radioOptions.genres[0].nome);
    if (!genre) return null;
    return { mode: 'genre', genre };
  }
  if (c.mode === 'decade') {
    const decade = Number(c.decade || (state.radioOptions && state.radioOptions.decades[0] && state.radioOptions.decades[0].decade));
    if (!Number.isFinite(decade)) return null;
    return { mode: 'decade', yearMin: decade };
  }
  // String(numero) su una casella vuota darebbe 0: qui vuoto vuol dire mancante.
  const numero = (v) => (String(v).trim() === '' ? NaN : Number(v));
  const lo = numero(c.yearMin);
  const hi = numero(c.yearMax);
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
    toast('Indica l\u2019anno di inizio e quello di fine');
    return false;
  }
  if (lo < 1900 || hi < lo) {
    toast('Periodo non valido: dal 1900 in poi, e la fine non prima dell\u2019inizio');
    return false;
  }
  return { mode: 'years', yearMin: lo, yearMax: hi };
}

async function loadRadioOptions() {
  if (state.radioOptions) return;
  try {
    state.radioOptions = await api('/api/radio/options');
    if (location.hash.replace(/^#\/?/, '').split('/')[0] === 'radio') renderRadio();
  } catch (e) {}
}

function renderRadio() {
  const v = $('#view');
  const busy = state.radioBusy;
  const eps = state.radioEpisodes || [];
  let html = '<h1 class="view-title">Radio Solco</h1>' +
    '<div class="view-sub">Una puntata di circa 45 minuti. Il taglio lo sceglie l\'IA da sola, oppure lo decidi tu qui sotto.</div>' +
    '<div class="radio-launch">' +
    '<div class="radio-cut" id="radioCut">' + renderRadioCut() + '</div>' +
    '<button class="btn big-btn" id="radioGenerate"' + (busy ? ' disabled' : '') + '>' +
    (busy ? 'Sto preparando la puntata…' : 'Nuova puntata') + '</button>' +
    (busy ? '<div class="web-loading"><span class="web-spinner"></span>L\'IA sta scegliendo taglio e scaletta. Può richiedere un minuto.</div>' : '') +
    (!busy && state.radioError ? '<div class="web-warning">' + esc(state.radioError) + '</div>' : '') +
    '</div>';
  if (!eps.length && !busy) {
    html += '<div class="empty"><h2>Nessuna puntata ancora</h2>' +
      '<p>Premi «Nuova puntata»: l\'IA sceglie tema e brani, la trasmissione parte da sola e resta qui per essere riascoltata.</p></div>';
  } else if (eps.length) {
    html += '<h2 class="section-title">Puntate memorizzate</h2>' +
      '<div class="radio-list">' + eps.map(radioEpisodeCard).join('') + '</div>';
  }
  v.innerHTML = html;
}

async function generateRadioEpisode() {
  if (state.radioBusy) return;
  const richiesta = radioRequest();
  if (richiesta === false) return;
  state.radioBusy = true;
  state.radioError = '';
  if (location.hash.replace(/^#\/?/, '').split('/')[0] === 'radio') renderRadio();
  try {
    const r = await api('/api/radio/episode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(richiesta || {})
    });
    state.radioEpisodes.unshift(r.episode);
    state.radioBusy = false;
    if (location.hash.replace(/^#\/?/, '').split('/')[0] === 'radio') renderRadio();
    playEntries(radioEpisodeEntries(r.episode), 0);
    api('/api/radio/episode-played', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: r.episode.id })
    }).then(() => {
      const ep = state.radioEpisodes.find((e) => e.id === r.episode.id);
      if (ep) { ep.playCount = (ep.playCount || 0) + 1; ep.lastPlayedAt = Date.now(); }
    }).catch(() => {});
    toast('In onda: ' + r.episode.title);
  } catch (err) {
    state.radioBusy = false;
    // Sotto il pulsante e non in un toast: spiegare perche' un tema non ha preso
    // richiede piu' di due secondi di lettura, e l'elenco delle parole provate
    // serve a riformularlo.
    state.radioError = err.message;
    if (location.hash.replace(/^#\/?/, '').split('/')[0] === 'radio') renderRadio();
    else toast(err.message);
  }
}

function updateRadioMeta(ep) {
  const el = document.querySelector('[data-radio-meta="' + CSS.escape(ep.id) + '"]');
  if (el) el.textContent = radioMetaText(ep);
}

function playRadioEpisode(id, startIdx) {
  const ep = state.radioEpisodes.find((e) => e.id === id);
  if (!ep) return;
  const giaInOnda = isRadioOnAir(id);
  playEntries(radioEpisodeEntries(ep), startIdx || 0);
  toast('In onda: ' + ep.title);
  // saltare a un brano di una puntata gia' in onda non e' un nuovo ascolto
  if (giaInOnda) return;
  api('/api/radio/episode-played', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  }).then(() => {
    ep.playCount = (ep.playCount || 0) + 1;
    ep.lastPlayedAt = Date.now();
    updateRadioMeta(ep);
  }).catch(() => {});
}

async function deleteRadioEpisode(id) {
  const ep = state.radioEpisodes.find((e) => e.id === id);
  if (ep && !confirm('Eliminare la puntata "' + ep.title + '"?')) return;
  try {
    await api('/api/radio/episodes?id=' + encodeURIComponent(id), { method: 'DELETE' });
    state.radioEpisodes = state.radioEpisodes.filter((e) => e.id !== id);
    renderRadio();
    toast('Puntata eliminata');
  } catch (err) {
    toast(err.message);
  }
}

function renderArtists() {
  const map = new Map();
  for (const a of state.albums) {
    if (!map.has(a.artist)) map.set(a.artist, []);
    map.get(a.artist).push(a);
  }
  const artists = [...map.entries()].sort((x, y) => x[0].localeCompare(y[0], undefined, { numeric: true }));
  const v = $('#view');
  if (!artists.length) {
    v.innerHTML = '<div class="empty"><h2>Nessun artista</h2></div>';
    return;
  }
  v.innerHTML = '<h1 class="view-title">Artisti</h1>' +
    '<div class="artist-list">' + artists.map(([name, albums]) =>
      '<div class="artist-row" data-artist-link="' + encodeURIComponent(name) + '">' +
      '<div class="av">' + esc(name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()) + '</div>' +
      '<div class="a-name">' + esc(name) + '</div>' +
      '<div class="a-count">' + albums.length + ' album</div>' +
      '</div>'
    ).join('') + '</div>';
}

function renderArtist(name) {
  const albums = state.albums.filter((a) => a.artist === name);
  const v = $('#view');
  if (!albums.length) {
    v.innerHTML = '<div class="empty"><h2>Artista non trovato</h2></div>';
    return;
  }
  v.innerHTML = '<h1 class="view-title">' + esc(name) + '</h1>' +
    '<section id="artistWebInfo" class="web-info artist-web" data-artist="' + encodeURIComponent(name) + '"></section>' +
    '<h2 class="section-title">Nella tua raccolta</h2>' +
    '<div class="view-sub">' + albums.length + ' album</div>' +
    '<div class="grid">' + albums.map(albumCard).join('') + '</div>';
  loadArtistWebInfo(name, false);
}

function renderAlbum(id) {
  const a = albumById(id);
  const v = $('#view');
  if (!a) {
    v.innerHTML = '<div class="empty"><h2>Album non trovato</h2><button class="btn" onclick="location.hash=\'#/\'">Torna alla home</button></div>';
    return;
  }
  v.innerHTML =
    '<div class="album-head">' + coverHtml(a) +
    '<div class="ah-info">' +
    '<div class="ah-label">Album</div>' +
    '<h1>' + esc(a.title) + '</h1>' +
    '<div class="ah-sub">' +
    '<span class="linkish" data-artist-link="' + encodeURIComponent(a.artist) + '">' + esc(a.artist) + '</span>' +
    (a.year ? ' · ' + esc(a.year) : '') +
    ' · ' + a.tracks.length + ' brani' +
    (a.duration ? ' · ' + esc(fmtAlbumDuration(a.duration)) : '') +
    (albumStats(a.id).plays
      ? ' · ascoltato ' + albumStats(a.id).plays + (albumStats(a.id).plays === 1 ? ' volta' : ' volte')
      : '') +
    '</div>' +
    '<div class="btn-row">' +
    '<button class="btn" data-play-album="' + encodeURIComponent(a.id) + '">Riproduci</button>' +
    '<button class="btn ghost icon-btn' + (isFavorite(a.id) ? ' fav-on' : '') + '" data-fav="' + encodeURIComponent(a.id) + '"' +
    ' title="' + (isFavorite(a.id) ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti') + '">' +
    (isFavorite(a.id) ? SVG.heart : SVG.heartOff) + '</button>' +
    '<button class="btn ghost" data-queue-album="' + encodeURIComponent(a.id) + '">Aggiungi alla coda</button>' +
    '<button class="btn ghost" data-add-album="' + encodeURIComponent(a.id) + '">Aggiungi a playlist</button>' +
    '<button class="btn ghost" data-album-web="' + encodeURIComponent(a.id) + '">Cerca info sul web + AI</button>' +
    '</div></div></div>' +
    albumSheet(a) +
    '<section id="albumWebInfo" class="web-info hidden" data-album="' + encodeURIComponent(a.id) + '"></section>' +
    '<h2 class="section-title tracks-title">Brani</h2>' +
    '<div class="tracklist">' + a.tracks.map((t) => trackRow(t, a)).join('') + '</div>';
}

function renderPlaylist(id) {
  const p = state.playlists.find((x) => x.id === id);
  const v = $('#view');
  if (!p) {
    v.innerHTML = '<div class="empty"><h2>Playlist non trovata</h2><button class="btn" onclick="location.hash=\'#/\'">Torna alla home</button></div>';
    return;
  }
  v.innerHTML = '<h1 class="view-title">' + esc(p.name) + '</h1>' +
    '<div class="view-sub">' + p.tracks.length + ' brani</div>' +
    '<div class="btn-row">' +
    '<button class="btn" data-play-pl="' + p.id + '">Riproduci</button>' +
    '<button class="btn ghost" data-del-pl="' + p.id + '" id="delPlaylistBtn">Elimina playlist</button>' +
    '</div>' +
    '<div class="tracklist">' + p.tracks.map((t, i) => {
      const album = albumById(t.albumId);
      if (!album) {
        return '<div class="track" data-album="" data-i="-1"><span class="t-idx">' + (i + 1) + '</span>' +
          '<span class="t-title" style="color:#666;">' + esc(t.title) + ' (album non trovato)</span><span></span>' +
          '<button class="mini-btn rm-btn" data-rm-playlist="' + p.id + '" data-pos="' + i + '" title="Rimuovi">' + SVG.trash + '</button></div>';
      }
      return '<div class="track" data-album="' + t.albumId + '" data-i="' + t.index + '"' +
        ' data-pl-src="' + p.id + '" data-pl-pos="' + i + '">' +
        '<span class="t-idx">' + (i + 1) + '</span>' +
        '<span class="t-title">' + esc(t.title) + ' <span style="color:#666;">· ' + esc(t.artist) + ' — ' + esc(t.album) + '</span></span>' +
        '<span class="t-ext"></span>' +
        '<button class="mini-btn rm-btn" data-rm-playlist="' + p.id + '" data-pos="' + i + '" title="Rimuovi dalla playlist">' + SVG.trash + '</button></div>';
    }).join('') + '</div>';
}

function renderSearch(q) {
  const ql = q.toLowerCase();
  const albums = state.albums.filter((a) =>
    (a.artist + ' ' + a.title + ' ' + (a.year || '') + ' ' + (a.genre || []).join(' ')).toLowerCase().includes(ql));
  const tracks = [];
  for (const a of state.albums) {
    for (const t of a.tracks) {
      if ((t.title + ' ' + a.artist + ' ' + a.title).toLowerCase().includes(ql)) {
        tracks.push(entryFor(a, t));
      }
    }
  }
  state.searchTracks = tracks;
  const v = $('#view');
  if (!albums.length && !tracks.length) {
    v.innerHTML = '<h1 class="view-title">Cerca</h1><div class="empty"><h2>Nessun risultato per "' + esc(q) + '"</h2></div>';
    return;
  }
  let html = '<h1 class="view-title">Risultati per "' + esc(q) + '"</h1>';
  if (tracks.length) {
    html += '<h2 class="section-title">Brani</h2><div class="tracklist">' + tracks.map((t, i) => {
      return '<div class="track" data-album="' + t.albumId + '" data-i="' + t.index + '"' +
        ' data-search-pos="' + i + '">' +
        '<span class="t-idx">' + (i + 1) + '</span>' +
        '<span class="t-title">' + esc(t.title) + ' <span style="color:#666;">· ' + esc(t.artist) + ' — ' + esc(t.album) + '</span></span>' +
        '<span class="t-ext"></span>' +
        '<button class="mini-btn add-btn" data-add-to-pl title="Aggiungi a playlist">' + SVG.plus + '</button></div>';
    }).join('') + '</div>';
  }
  if (albums.length) {
    html += '<h2 class="section-title">Album</h2><div class="grid">' + albums.map(albumCard).join('') + '</div>';
  }
  v.innerHTML = html;
}

/* ---------------- Router ---------------- */

function router() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, ...rest] = h.split('/');
  const param = rest.length ? decodeURIComponent(rest.join('/')) : '';
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === view));
  if (view === 'preferiti') return renderFavorites();
  if (view === 'radio') {
    loadRadioOptions();
    return renderRadio();
  }
  if (view === 'artisti') return renderArtists();
  if (view === 'artista') return renderArtist(param);
  if (view === 'album') return renderAlbum(param);
  if (view === 'playlist') return renderPlaylist(param);
  if (view === 'cerca') {
    $('#searchInput').value = param;
    return renderSearch(param);
  }
  renderHome();
}

/* ---------------- Queue panel ---------------- */

function renderQueuePanel() {
  const list = $('#queueList');
  if (!state.queue.length) {
    list.innerHTML = '<div style="padding:20px;color:#666;text-align:center;">La coda è vuota</div>';
    return;
  }
  list.innerHTML = state.queue.map((t, i) =>
    '<div class="q-item' + (i === state.pos ? ' current' : '') + '" data-queue-pos="' + i + '" draggable="true">' +
    '<div class="q-thumb">' + (t.cover ? '<img src="/api/cover?id=' + encodeURIComponent(t.albumId) + '">' : '') + '</div>' +
    '<div class="q-meta"><div class="q-title">' + esc(t.title) + '</div>' +
    '<div class="q-artist">' + esc(t.artist) + '</div></div>' +
    '<button class="q-rm" data-queue-rm="' + i + '" title="Rimuovi dalla coda">' + SVG.trash + '</button>' +
    '</div>'
  ).join('');
  list.scrollTop = Math.max(0, (state.pos - 1) * 44);
}

/* Riordino della coda: insertAt è l'indice di inserimento nell'array originale (0..lunghezza). */
function moveQueueItem(from, insertAt) {
  if (!Number.isInteger(from) || from < 0 || from >= state.queue.length) return;
  if (from === insertAt || from === insertAt - 1) return;
  const moved = state.queue[from];
  const playing = state.pos >= 0 ? state.queue[state.pos] : null;
  const next = state.queue.slice();
  next.splice(from, 1);
  next.splice(insertAt > from ? insertAt - 1 : insertAt, 0, moved);
  state.queue = next;
  if (playing) state.pos = next.indexOf(playing);
  renderQueuePanel();
}

function clearDropMarks() {
  document.querySelectorAll('#queueList .q-item').forEach((el) => {
    el.classList.remove('drop-above', 'drop-below', 'dragging');
  });
}

function removeFromQueue(pos) {
  if (pos === state.pos) {
    nextTrack();
    state.queue.splice(pos, 1);
    if (state.pos > pos) state.pos--;
  } else {
    state.queue.splice(pos, 1);
    if (pos < state.pos) state.pos--;
  }
  renderQueuePanel();
}

/* ---------------- Testo del brano ---------------- */

function lyricsPanelOpen() {
  return !$('#lyricsPanel').classList.contains('hidden');
}

function lyricsKey(entry) {
  return entry ? entry.albumId + '|' + entry.index : null;
}

function renderLyrics(message) {
  const list = $('#lyricsList');
  if (message) {
    list.innerHTML = '<div class="lyr-empty">' + esc(message) + '</div>';
    return;
  }
  list.innerHTML = state.lyrics.lines
    .map((line, i) => '<div class="lyr-line' + (line.text ? '' : ' blank') + '" data-lyr="' + i + '">' +
      (line.text ? esc(line.text) : '·') + '</div>')
    .join('');
}

async function loadLyrics(force) {
  if (!lyricsPanelOpen()) return;
  const entry = state.current;
  if (!entry) {
    state.lyrics = { key: null, synced: false, lines: [], active: -1 };
    $('#lyricsSource').textContent = '';
    return renderLyrics('Nessun brano in riproduzione');
  }
  const key = lyricsKey(entry);
  if (!force && state.lyrics.key === key) return;
  state.lyrics = { key, synced: false, lines: [], active: -1 };
  $('#lyricsSource').textContent = '';
  renderLyrics('Ricerca del testo…');
  try {
    const data = await api('/api/lyrics?id=' + encodeURIComponent(entry.albumId) + '&i=' + entry.index);
    if (state.lyrics.key !== key) return;
    state.lyrics = { key, synced: !!data.synced, lines: data.lines || [], active: -1 };
    $('#lyricsSource').textContent = data.source || '';
    renderLyrics();
    syncLyrics(true);
  } catch (err) {
    if (state.lyrics.key !== key) return;
    renderLyrics(err.message);
  }
}

function syncLyrics(forceScroll) {
  const lyr = state.lyrics;
  if (!lyr.synced || !lyr.lines.length || !lyricsPanelOpen()) return;
  const t = audio.currentTime;
  let active = -1;
  for (let i = 0; i < lyr.lines.length; i++) {
    if (lyr.lines[i].time <= t) active = i;
    else break;
  }
  if (active === lyr.active && !forceScroll) return;
  lyr.active = active;
  const list = $('#lyricsList');
  list.querySelectorAll('.lyr-line.active').forEach((el) => el.classList.remove('active'));
  if (active < 0) return;
  const el = list.querySelector('[data-lyr="' + active + '"]');
  if (!el) return;
  el.classList.add('active');
  list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
}

/* ---------------- Playlist modal ---------------- */

function openPlaylistModal(target) {
  state.modalTarget = target || null;
  $('#modalTitle').textContent = target ? 'Aggiungi a playlist' : 'Nuova playlist';
  $('#modalLabel').textContent = target ? target.label : '';
  $('#modalNewName').value = '';
  $('#modalSelect').innerHTML = state.playlists.length
    ? '<option value="">— scegli una playlist —</option>' + state.playlists.map((p) => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('')
    : '<option value="">Nessuna playlist esistente</option>';
  $('#modal').classList.remove('hidden');
}

async function addToPlaylist(plId, target) {
  await api('/api/playlist-tracks', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playlistId: plId,
      albumId: target.albumId,
      index: target.all ? null : target.index
    })
  });
  const pls = await api('/api/playlists');
  state.playlists = pls.playlists;
  renderPlaylists();
  const pl = state.playlists.find((p) => p.id === plId);
  toast('Aggiunto a "' + (pl ? pl.name : 'playlist') + '"');
}

/* ---------------- Impostazioni IA ---------------- */

function fmtOpenRouterPrice(perToken) {
  if (perToken == null) return null;
  const perMillion = perToken * 1000000;
  return '$' + (perMillion < 1 ? perMillion.toFixed(3) : perMillion.toFixed(2)) + '/1M';
}

function openRouterModelLabel(m) {
  const parti = [m.name];
  if (m.contextLength) parti.push(Math.round(m.contextLength / 1000) + 'k ctx');
  parti.push(m.free ? 'gratuito' : (fmtOpenRouterPrice(m.promptPrice) || '?'));
  return parti.join(' — ');
}

function renderOpenRouterModelOptions(filtro) {
  const sel = $('#aiOpenRouterModel');
  const attuale = sel.value;
  const f = (filtro || '').toLowerCase().trim();
  const elenco = f ? state.openRouterModels.filter((m) => m.name.toLowerCase().includes(f) || m.id.toLowerCase().includes(f)) : state.openRouterModels;
  sel.innerHTML = elenco.map((m) => '<option value="' + esc(m.id) + '">' + esc(openRouterModelLabel(m)) + '</option>').join('');
  if (elenco.some((m) => m.id === attuale)) sel.value = attuale;
}

async function ensureOpenRouterModelsLoaded() {
  if (state.openRouterModels.length) return;
  try {
    const r = await api('/api/ai/models');
    state.openRouterModels = r.models || [];
  } catch (err) {
    $('#aiOpenRouterModelInfo').textContent = 'Elenco modelli non disponibile: ' + err.message;
  }
}

function updateOpenRouterModelInfo() {
  const id = $('#aiOpenRouterModel').value;
  const m = state.openRouterModels.find((x) => x.id === id);
  $('#aiOpenRouterModelInfo').textContent = m ? openRouterModelLabel(m) : '';
}

async function openAiSettingsModal() {
  $('#aiSettingsModal').classList.remove('hidden');
  $('#aiOpenRouterKey').value = '';
  $('#aiVerifyResult').textContent = '';
  $('#aiOpenRouterFilter').value = '';
  try {
    const cfg = await api('/api/ai/config');
    $('#aiProviderSelect').value = cfg.provider;
    $('#aiOpenRouterKey').placeholder = cfg.hasOpenRouterKey
      ? 'Chiave già impostata — lascia vuoto per non cambiarla'
      : 'sk-or-...';
    toggleAiProviderPanels();
    await ensureOpenRouterModelsLoaded();
    renderOpenRouterModelOptions('');
    if (cfg.openRouterModel) $('#aiOpenRouterModel').value = cfg.openRouterModel;
    updateOpenRouterModelInfo();
  } catch (err) {
    toast(err.message);
  }
  aggiornaAnalisi();
}

function closeAiSettingsModal() {
  $('#aiSettingsModal').classList.add('hidden');
  // l'analisi continua sul server; si smette solo di interrogarlo
  if (analisiTimer) { clearInterval(analisiTimer); analisiTimer = null; }
}

function toggleAiProviderPanels() {
  const isOpenRouter = $('#aiProviderSelect').value === 'openrouter';
  $('#aiProviderLmstudio').classList.toggle('hidden', isOpenRouter);
  $('#aiProviderOpenrouter').classList.toggle('hidden', !isOpenRouter);
}

async function verifyOpenRouterKeyClick() {
  const key = $('#aiOpenRouterKey').value.trim();
  $('#aiVerifyResult').textContent = 'Verifica in corso…';
  try {
    const r = await api('/api/ai/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key })
    });
    $('#aiVerifyResult').textContent = r.message;
    $('#aiVerifyResult').style.color = r.ok ? 'var(--accent-hi)' : '#ff8080';
  } catch (err) {
    $('#aiVerifyResult').textContent = err.message;
    $('#aiVerifyResult').style.color = '#ff8080';
  }
}

async function saveAiSettings() {
  const provider = $('#aiProviderSelect').value;
  const openRouterModel = $('#aiOpenRouterModel').value;
  const openRouterKey = $('#aiOpenRouterKey').value.trim();
  if (provider === 'openrouter' && !openRouterModel) {
    toast('Scegli un modello OpenRouter');
    return;
  }
  try {
    await api('/api/ai/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, openRouterModel, openRouterKey })
    });
    closeAiSettingsModal();
    toast('Impostazioni IA salvate');
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- Analisi del suono ---------------- */

let analisiTimer = null;

// Stima grossolana del tempo mancante: velocita' media da inizio analisi. Si tace
// finche' non ci sono abbastanza brani fatti, altrimenti i primi secondi darebbero
// numeri assurdi (il caricamento dei modelli pesa solo sul primo giro).
function stimaRimanente(s) {
  if (!s.iniziato || s.fatti < 5 || !s.totali) return null;
  const perBrano = (Date.now() - s.iniziato) / s.fatti;
  const min = Math.round((perBrano * (s.totali - s.fatti)) / 60000);
  if (min < 1) return 'meno di un minuto';
  if (min < 60) return min + ' minuti';
  const ore = Math.floor(min / 60);
  const resto = min % 60;
  return ore + (ore === 1 ? ' ora' : ' ore') + (resto ? ' e ' + resto + ' minuti' : '');
}

function renderAnalisiStato(s) {
  const box = $('#analisiStato');
  const barra = $('#analisiBarra');
  if (!s.ffmpeg) {
    box.innerHTML = '<span style="color:#ff8080;">ffmpeg non trovato: installalo per poter analizzare i brani ' +
      '(Windows: <code>winget install Gyan.FFmpeg</code> — macOS: <code>brew install ffmpeg</code>).</span>';
    $('#analisiAvviaBtn').disabled = true;
    return;
  }
  $('#analisiAvviaBtn').disabled = s.attivo;
  $('#analisiFermaBtn').classList.toggle('hidden', !s.attivo);

  if (s.attivo) {
    const perc = s.totali ? Math.round((s.fatti / s.totali) * 100) : 0;
    barra.style.width = perc + '%';
    const parti = [s.messaggio + ' — ' + s.fatti + '/' + s.totali + ' (' + perc + '%)'];
    if (s.worker > 1) parti.push(s.worker + ' brani per volta');
    const stima = stimaRimanente(s);
    if (stima) parti.push('circa ' + stima + ' alla fine');
    if (s.errori) parti.push(s.errori + (s.errori === 1 ? ' errore' : ' errori'));
    box.innerHTML = esc(parti.join(' · ')) +
      (s.corrente ? '<br><span class="analisi-brano">' + esc(s.corrente) + '</span>' : '');
  } else {
    barra.style.width = s.inCache && s.braniTotali ? Math.round((s.inCache / s.braniTotali) * 100) + '%' : '0';
    const analizzati = Math.min(s.inCache, s.braniTotali);
    box.textContent = s.daAnalizzare
      ? analizzati + ' brani su ' + s.braniTotali + ' già analizzati, ' + s.daAnalizzare + ' da fare.' +
        (s.messaggio ? ' (' + s.messaggio + ')' : '')
      : 'Tutti i ' + s.braniTotali + ' brani sono analizzati.';
    if (s.ultimoErrore) box.textContent += ' Ultimo errore: ' + s.ultimoErrore;
  }
}

async function aggiornaAnalisi() {
  try {
    const s = await api('/api/audio-analysis/status');
    renderAnalisiStato(s);
    if (s.attivo && !analisiTimer) analisiTimer = setInterval(aggiornaAnalisi, 2000);
    if (!s.attivo && analisiTimer) { clearInterval(analisiTimer); analisiTimer = null; }
  } catch (err) {
    $('#analisiStato').textContent = err.message;
  }
}

async function avviaAnalisi() {
  try {
    const r = await api('/api/audio-analysis/start', { method: 'POST' });
    toast(r.daAnalizzare ? 'Analisi avviata su ' + r.daAnalizzare + ' brani' : 'Niente da analizzare');
    aggiornaAnalisi();
  } catch (err) {
    toast(err.message);
  }
}

async function fermaAnalisi() {
  try {
    await api('/api/audio-analysis/stop', { method: 'POST' });
    toast('Interruzione richiesta');
    aggiornaAnalisi();
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- Playlist con l'IA ---------------- */

function aiPlaylistShow(stato) {
  $('#aiPlaylistForm').classList.toggle('hidden', stato !== 'form');
  $('#aiPlaylistLoading').classList.toggle('hidden', stato !== 'loading');
  $('#aiPlaylistError').classList.toggle('hidden', stato !== 'error');
  $('#aiPlaylistPreview').classList.toggle('hidden', stato !== 'preview');
}

function openAiPlaylistModal() {
  state.aiPlaylistDraft = null;
  $('#aiPlaylistPrompt').value = '';
  aiPlaylistShow('form');
  $('#aiPlaylistModal').classList.remove('hidden');
  $('#aiPlaylistPrompt').focus();
}

function closeAiPlaylistModal() {
  $('#aiPlaylistModal').classList.add('hidden');
}

function renderAiPlaylistTracks() {
  const draft = state.aiPlaylistDraft;
  const box = $('#aiPlaylistTracks');
  if (!draft || !draft.tracks.length) {
    box.innerHTML = '<p class="hint">Nessun brano selezionato.</p>';
    return;
  }
  box.innerHTML = draft.tracks.map((t, i) =>
    '<div class="track" data-ai-pos="' + i + '">' +
    '<span class="t-idx">' + (i + 1) + '</span>' +
    '<span class="t-title">' + esc(t.title) + ' <span style="color:#666;">· ' + esc(t.artist) + ' — ' + esc(t.album) + '</span></span>' +
    '<span class="t-ext">' + (t.duration ? esc(fmt(t.duration)) : '') + '</span>' +
    '<button class="mini-btn rm-btn" data-ai-rm="' + i + '" title="Togli dalla playlist">' + SVG.trash + '</button>' +
    '</div>'
  ).join('');
}

function renderAiPlaylistWarnings() {
  const draft = state.aiPlaylistDraft;
  const box = $('#aiPlaylistWarnings');
  const warnings = (draft && draft.warnings) || [];
  box.innerHTML = warnings.length
    ? '<div class="web-warning">' + warnings.map((w) => esc(w)).join('<br>') + '</div>'
    : '';
}

async function generateAiPlaylist() {
  const prompt = $('#aiPlaylistPrompt').value.trim();
  if (!prompt) return;
  aiPlaylistShow('loading');
  try {
    const result = await api('/api/ai/playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    state.aiPlaylistDraft = result;
    $('#aiPlaylistName').value = result.name || '';
    $('#aiPlaylistNote').textContent = result.note || '';
    $('#aiPlaylistNote').classList.toggle('hidden', !result.note);
    renderAiPlaylistWarnings();
    renderAiPlaylistTracks();
    aiPlaylistShow('preview');
  } catch (err) {
    $('#aiPlaylistErrorText').textContent = err.message;
    aiPlaylistShow('error');
  }
}

async function createAiPlaylistFromDraft() {
  const draft = state.aiPlaylistDraft;
  if (!draft || !draft.tracks.length) return;
  const name = $('#aiPlaylistName').value.trim() || 'Playlist generata';
  try {
    const pl = await api('/api/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    await api('/api/playlist-tracks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playlistId: pl.id,
        tracks: draft.tracks.map((t) => ({ albumId: t.albumId, index: t.index }))
      })
    });
    const pls = await api('/api/playlists');
    state.playlists = pls.playlists;
    renderPlaylists();
    closeAiPlaylistModal();
    location.hash = '#/playlist/' + pl.id;
    toast('Playlist "' + name + '" creata');
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- Genre editor ---------------- */

function openGenreModal(albumId) {
  const album = albumById(albumId);
  if (!album) return;
  state.genreAlbumId = album.id;
  $('#genreAlbumLabel').textContent = album.title + ' — ' + album.artist;
  $('#genreInput').value = (album.genre || []).join(', ');
  $('#genreReset').classList.toggle('hidden', !album.genreManual);
  $('#genreModal').classList.remove('hidden');
  $('#genreInput').focus();
  $('#genreInput').select();
}

function closeGenreModal() {
  state.genreAlbumId = null;
  $('#genreModal').classList.add('hidden');
}

async function saveGenre() {
  if (!state.genreAlbumId) return;
  await api('/api/album-metadata', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ albumId: state.genreAlbumId, genre: $('#genreInput').value })
  });
  await refreshLibrary();
  closeGenreModal();
  toast('Genere aggiornato');
}

async function resetGenre() {
  if (!state.genreAlbumId) return;
  await api('/api/album-metadata?id=' + encodeURIComponent(state.genreAlbumId), { method: 'DELETE' });
  await refreshLibrary();
  closeGenreModal();
  toast('Genere ripristinato dai tag');
}

/* ---------------- Toast ---------------- */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------------- Events ---------------- */

document.addEventListener('click', (e) => {
  const albumWeb = e.target.closest('[data-album-web]');
  if (albumWeb) {
    loadAlbumWebInfo(decodeURIComponent(albumWeb.dataset.albumWeb), false);
    return;
  }
  const refreshAlbumWeb = e.target.closest('[data-refresh-album-web]');
  if (refreshAlbumWeb) {
    loadAlbumWebInfo(decodeURIComponent(refreshAlbumWeb.dataset.refreshAlbumWeb), true);
    return;
  }
  const refreshArtistWeb = e.target.closest('[data-refresh-artist-web]');
  if (refreshArtistWeb) {
    loadArtistWebInfo(decodeURIComponent(refreshArtistWeb.dataset.refreshArtistWeb), true);
    return;
  }
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    e.stopPropagation();
    toggleFavorite(decodeURIComponent(fav.dataset.fav));
    return;
  }
  const editGenre = e.target.closest('[data-edit-genre]');
  if (editGenre) {
    openGenreModal(decodeURIComponent(editGenre.dataset.editGenre));
    return;
  }
  const qp = e.target.closest('[data-quickplay]');
  if (qp) {
    e.stopPropagation();
    playAlbumTracks(albumById(decodeURIComponent(qp.dataset.quickplay)), 0, true);
    return;
  }
  const playAl = e.target.closest('[data-play-album]');
  if (playAl) {
    playAlbumTracks(albumById(decodeURIComponent(playAl.dataset.playAlbum)), 0, true);
    return;
  }
  const queueAl = e.target.closest('[data-queue-album]');
  if (queueAl) {
    addToQueue(albumById(decodeURIComponent(queueAl.dataset.queueAlbum)), 0);
    return;
  }
  const addAl = e.target.closest('[data-add-album]');
  if (addAl) {
    const album = albumById(decodeURIComponent(addAl.dataset.addAlbum));
    openPlaylistModal({ albumId: album.id, all: true, label: 'Tutto l\'album "' + album.title + '" di ' + album.artist });
    return;
  }
  const addBtn = e.target.closest('[data-add-to-pl]');
  if (addBtn) {
    const track = addBtn.closest('.track');
    const album = albumById(track.dataset.album);
    const t = album.tracks.find((x) => x.i === +track.dataset.i);
    openPlaylistModal({ albumId: album.id, index: t.i, label: '"' + t.title + '" — ' + album.artist });
    return;
  }
  const aiRm = e.target.closest('[data-ai-rm]');
  if (aiRm) {
    e.stopPropagation();
    const pos = +aiRm.dataset.aiRm;
    if (state.aiPlaylistDraft) {
      state.aiPlaylistDraft.tracks.splice(pos, 1);
      renderAiPlaylistTracks();
    }
    return;
  }
  const rmPl = e.target.closest('[data-rm-playlist]');
  if (rmPl) {
    const pos = +rmPl.dataset.pos;
    api('/api/playlist-tracks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlistId: rmPl.dataset.rmPlaylist, position: pos })
    }).then(async () => {
      const pls = await api('/api/playlists');
      state.playlists = pls.playlists;
      renderPlaylists();
      router();
    }).catch((err) => toast(err.message));
    return;
  }
  const radioGen = e.target.closest('#radioGenerate');
  if (radioGen) {
    generateRadioEpisode();
    return;
  }
  const radioPlay = e.target.closest('[data-radio-play]');
  if (radioPlay) {
    if (isRadioOnAir(radioPlay.dataset.radioPlay)) toast('Questa puntata è già in onda');
    else playRadioEpisode(radioPlay.dataset.radioPlay, 0);
    return;
  }
  const radioExpand = e.target.closest('[data-radio-expand]');
  if (radioExpand) {
    toggleRadioCard(radioExpand.dataset.radioExpand);
    return;
  }
  const radioQueue = e.target.closest('[data-radio-queue]');
  if (radioQueue) {
    const ep = state.radioEpisodes.find((x) => x.id === radioQueue.dataset.radioQueue);
    if (ep) {
      const entries = radioEpisodeEntries(ep);
      if (!state.queue.length) { playEntries(entries, 0); }
      else { state.queue.push(...entries); renderQueuePanel(); }
      toast('Puntata aggiunta alla coda');
    }
    return;
  }
  const radioSave = e.target.closest('[data-radio-save]');
  if (radioSave) {
    e.stopPropagation();
    saveEpisodeAsPlaylist(radioSave.dataset.radioSave);
    return;
  }
  const radioDel = e.target.closest('[data-radio-del]');
  if (radioDel) {
    e.stopPropagation();
    deleteRadioEpisode(radioDel.dataset.radioDel);
    return;
  }
  const radioCrit = e.target.closest('[data-radio-crit]');
  if (radioCrit) {
    const card = radioCrit.closest('[data-radio-card]');
    const box = card && card.querySelector('.radio-crit');
    if (box) {
      const nascosto = box.classList.toggle('hidden');
      radioCrit.textContent = nascosto ? 'Mostra i criteri' : 'Nascondi i criteri';
    }
    return;
  }
  const radioToggle = e.target.closest('[data-radio-toggle]');
  if (radioToggle) {
    const card = radioToggle.closest('[data-radio-card]');
    const box = card && card.querySelector('.radio-ep-tracks');
    if (box) {
      const hidden = box.classList.toggle('hidden');
      radioToggle.textContent = hidden ? 'Mostra la scaletta' : 'Nascondi la scaletta';
    }
    return;
  }

  const track = e.target.closest('.track');
  if (track && track.dataset.radioEp) {
    const ep = state.radioEpisodes.find((x) => x.id === track.dataset.radioEp);
    if (ep) playRadioEpisode(ep.id, +track.dataset.radioPos);
    return;
  }
  if (track && track.dataset.plSrc) {
    const p = state.playlists.find((x) => x.id === track.dataset.plSrc);
    if (p) playEntries(p.tracks, +track.dataset.plPos);
    return;
  }
  if (track && track.dataset.searchPos) {
    const pos = +track.dataset.searchPos;
    if (state.searchTracks[pos]) playEntries(state.searchTracks, pos);
    return;
  }
  if (track && track.dataset.album) {
    const album = albumById(track.dataset.album);
    if (album) playAlbumTracks(album, +track.dataset.i);
    return;
  }
  const artist = e.target.closest('[data-artist-link]');
  if (artist) {
    location.hash = '#/artista/' + artist.dataset.artistLink;
    return;
  }
  const card = e.target.closest('[data-album-link]');
  if (card) {
    location.hash = '#/album/' + card.dataset.albumLink;
    return;
  }
  const delPl = e.target.closest('[data-del-playlist]');
  if (delPl) {
    e.stopPropagation();
    const p = state.playlists.find((x) => x.id === delPl.dataset.delPlaylist);
    if (p && confirm('Eliminare la playlist "' + p.name + '"?')) {
      api('/api/playlists?id=' + encodeURIComponent(p.id), { method: 'DELETE' }).then(async () => {
        state.playlists = state.playlists.filter((x) => x.id !== p.id);
        renderPlaylists();
        toast('Playlist eliminata');
      }).catch((err) => toast(err.message));
    }
    return;
  }
  const pl = e.target.closest('[data-playlist-link]');
  if (pl) {
    location.hash = '#/playlist/' + pl.dataset.playlistLink;
    return;
  }
  const playPl = e.target.closest('[data-play-pl]');
  if (playPl) {
    const p = state.playlists.find((x) => x.id === playPl.dataset.playPl);
    playEntries(p.tracks, 0);
    return;
  }
  const delPlBtn = e.target.closest('#delPlaylistBtn');
  if (delPlBtn) {
    const id = delPlBtn.dataset.delPl;
    const p = state.playlists.find((x) => x.id === id);
    if (p && confirm('Eliminare la playlist "' + p.name + '"?')) {
      api('/api/playlists?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(async () => {
        state.playlists = state.playlists.filter((x) => x.id !== id);
        renderPlaylists();
        location.hash = '#/';
        toast('Playlist eliminata');
      }).catch((err) => toast(err.message));
    }
    return;
  }
  const qrm = e.target.closest('[data-queue-rm]');
  if (qrm) {
    e.stopPropagation();
    removeFromQueue(+qrm.dataset.queueRm);
    return;
  }
  const qi = e.target.closest('[data-queue-pos]');
  if (qi) {
    playAt(+qi.dataset.queuePos);
    return;
  }
});

$('#playBtn').addEventListener('click', togglePlay);
$('#nextBtn').addEventListener('click', nextTrack);
$('#prevBtn').addEventListener('click', prevTrack);

$('#shuffleBtn').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  updatePlayerUI();
});

$('#repeatBtn').addEventListener('click', () => {
  state.repeat = (state.repeat + 1) % 3;
  updatePlayerUI();
});

$('#queueBtn').addEventListener('click', () => {
  const panel = $('#queuePanel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    $('#lyricsPanel').classList.add('hidden');
    $('#lyricsBtn').classList.remove('active');
    renderQueuePanel();
  }
  $('#queueBtn').classList.toggle('active', !panel.classList.contains('hidden'));
});

$('#lyricsBtn').addEventListener('click', () => {
  const panel = $('#lyricsPanel');
  panel.classList.toggle('hidden');
  const open = !panel.classList.contains('hidden');
  $('#lyricsBtn').classList.toggle('active', open);
  if (open) {
    $('#queuePanel').classList.add('hidden');
    $('#queueBtn').classList.remove('active');
    loadLyrics(true);
  }
});

let dragFrom = -1;

$('#queueList').addEventListener('dragstart', (e) => {
  const item = e.target.closest('.q-item');
  if (!item) return;
  dragFrom = +item.dataset.queuePos;
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom));
});

$('#queueList').addEventListener('dragover', (e) => {
  if (dragFrom < 0) return;
  const item = e.target.closest('.q-item');
  if (!item) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const rect = item.getBoundingClientRect();
  const sopra = e.clientY < rect.top + rect.height / 2;
  document.querySelectorAll('#queueList .q-item').forEach((el) => el.classList.remove('drop-above', 'drop-below'));
  item.classList.add(sopra ? 'drop-above' : 'drop-below');
});

$('#queueList').addEventListener('drop', (e) => {
  if (dragFrom < 0) return;
  const item = e.target.closest('.q-item');
  if (!item) return;
  e.preventDefault();
  const rect = item.getBoundingClientRect();
  const target = +item.dataset.queuePos;
  const insertAt = e.clientY < rect.top + rect.height / 2 ? target : target + 1;
  const from = dragFrom;
  dragFrom = -1;
  clearDropMarks();
  moveQueueItem(from, insertAt);
});

$('#queueList').addEventListener('dragend', () => {
  dragFrom = -1;
  clearDropMarks();
});

$('#clearQueueBtn').addEventListener('click', () => {
  state.queue = [];
  state.pos = -1;
  state.current = null;
  audio.pause();
  audio.removeAttribute('src');
  renderQueuePanel();
  updatePlayerUI();
});

$('#newPlaylistBtn').addEventListener('click', () => openPlaylistModal(null));

$('#aiSettingsBtn').addEventListener('click', openAiSettingsModal);
$('#aiSettingsCloseBtn').addEventListener('click', closeAiSettingsModal);
$('#aiSettingsSaveBtn').addEventListener('click', saveAiSettings);
$('#aiSettingsModal').addEventListener('click', (e) => {
  if (e.target === $('#aiSettingsModal')) closeAiSettingsModal();
});
$('#aiProviderSelect').addEventListener('change', toggleAiProviderPanels);
$('#aiVerifyBtn').addEventListener('click', verifyOpenRouterKeyClick);
$('#aiOpenRouterFilter').addEventListener('input', () => renderOpenRouterModelOptions($('#aiOpenRouterFilter').value));
$('#aiOpenRouterModel').addEventListener('change', updateOpenRouterModelInfo);
$('#analisiAvviaBtn').addEventListener('click', avviaAnalisi);
$('#analisiFermaBtn').addEventListener('click', fermaAnalisi);

$('#aiPlaylistBtn').addEventListener('click', openAiPlaylistModal);
$('#aiPlaylistCloseBtn1').addEventListener('click', closeAiPlaylistModal);
$('#aiPlaylistCloseBtn2').addEventListener('click', closeAiPlaylistModal);
$('#aiPlaylistGoBtn').addEventListener('click', generateAiPlaylist);
$('#aiPlaylistBackBtn').addEventListener('click', () => aiPlaylistShow('form'));
$('#aiPlaylistRetryBtn').addEventListener('click', () => aiPlaylistShow('form'));
$('#aiPlaylistCreateBtn').addEventListener('click', createAiPlaylistFromDraft);
$('#aiPlaylistModal').addEventListener('click', (e) => {
  if (e.target === $('#aiPlaylistModal')) closeAiPlaylistModal();
});

$('#modalClose').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#modal').addEventListener('click', (e) => {
  if (e.target === $('#modal')) $('#modal').classList.add('hidden');
});

$('#modalAddBtn').addEventListener('click', async () => {
  const selId = $('#modalSelect').value;
  const newName = $('#modalNewName').value.trim();
  const target = state.modalTarget;
  try {
    if (newName) {
      const pl = await api('/api/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });
      const pls = await api('/api/playlists');
      state.playlists = pls.playlists;
      renderPlaylists();
      if (target) {
        await addToPlaylist(pl.id, target);
      } else {
        location.hash = '#/playlist/' + pl.id;
        toast('Playlist creata');
      }
    } else if (selId) {
      if (target) await addToPlaylist(selId, target);
    }
    $('#modal').classList.add('hidden');
  } catch (err) {
    toast(err.message);
  }
});

$('#modalNewName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#modalAddBtn').click();
});

$('#genreSave').addEventListener('click', () => saveGenre().catch((err) => toast(err.message)));
$('#genreReset').addEventListener('click', () => resetGenre().catch((err) => toast(err.message)));
$('#genreClose').addEventListener('click', closeGenreModal);
$('#genreModal').addEventListener('click', (e) => {
  if (e.target === $('#genreModal')) closeGenreModal();
});
$('#genreInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#genreSave').click();
  if (e.key === 'Escape') closeGenreModal();
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'sortSelect') {
    state.sort = e.target.value;
    renderHome();
    return;
  }
  if (e.target.id === 'genreSelect') {
    state.genreFilter = e.target.value;
    renderHome();
  }
});

/* ---------------- Ricerca veloce (artisti e album) ---------------- */

const quick = { items: [], active: -1, open: false };

function nameInitials(name) {
  return String(name || '?').split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
}

function quickMatches(q) {
  const ql = q.toLowerCase();
  const counts = new Map();
  for (const a of state.albums) counts.set(a.artist, (counts.get(a.artist) || 0) + 1);
  const artists = [...counts.keys()]
    .filter((name) => name.toLowerCase().includes(ql))
    .sort((x, y) => x.localeCompare(y, 'it', { numeric: true }))
    .slice(0, 6)
    .map((name) => ({ name, count: counts.get(name) }));
  const albums = state.albums
    .filter((a) => (a.artist + ' ' + a.title).toLowerCase().includes(ql))
    .sort((a, b) =>
      a.artist.localeCompare(b.artist, 'it', { numeric: true }) ||
      a.title.localeCompare(b.title, 'it', { numeric: true }))
    .slice(0, 8);
  return { artists, albums };
}

function positionQuickBox() {
  const wrap = document.querySelector('.search-wrap');
  const box = $('#quickResults');
  if (!wrap || !box) return;
  const r = wrap.getBoundingClientRect();
  box.style.left = r.left + 'px';
  box.style.top = (r.bottom + 6) + 'px';
  box.style.width = r.width + 'px';
}

function closeQuickSearch() {
  const box = $('#quickResults');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  $('#searchInput').setAttribute('aria-expanded', 'false');
  quick.open = false;
  quick.active = -1;
  quick.items = [];
}

function highlightQuick() {
  document.querySelectorAll('#quickResults .quick-item').forEach((el) => {
    const on = +el.dataset.quickIdx === quick.active;
    el.classList.toggle('active', on);
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
}

function renderQuickSearch(raw) {
  const query = (raw || '').trim();
  const box = $('#quickResults');
  if (!box) return;
  if (!query || !state.albums.length) { closeQuickSearch(); return; }
  const { artists, albums } = quickMatches(query);
  quick.items = [
    ...artists.map((a) => ({ type: 'artista', name: a.name })),
    ...albums.map((a) => ({ type: 'album', id: a.id }))
  ];
  quick.active = -1;

  let html = '';
  if (!artists.length && !albums.length) {
    html += '<div class="quick-empty">Nessun artista o album per "' + esc(query) + '"</div>';
  }
  if (artists.length) {
    html += '<div class="quick-group-label">Artisti</div>';
    html += artists.map((a, i) =>
      '<div class="quick-item" role="option" data-quick-idx="' + i + '">' +
      '<span class="qi-avatar">' + esc(nameInitials(a.name)) + '</span>' +
      '<span class="qi-text"><span class="qi-title">' + esc(a.name) + '</span>' +
      '<span class="qi-sub">' + a.count + (a.count === 1 ? ' album' : ' album') + '</span></span>' +
      '<span class="qi-kind">Artista</span></div>'
    ).join('');
  }
  if (albums.length) {
    const base = artists.length;
    html += '<div class="quick-group-label">Album</div>';
    html += albums.map((a, i) => {
      const id = a.albumId || a.id;
      const img = a.cover
        ? '<img class="qi-cover" src="/api/cover?id=' + encodeURIComponent(id) + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=\'' + placeholderArt(a) + '\'">'
        : '<img class="qi-cover" src="' + placeholderArt(a) + '" alt="">';
      return '<div class="quick-item" role="option" data-quick-idx="' + (base + i) + '">' +
        img +
        '<span class="qi-text"><span class="qi-title">' + esc(a.title) + '</span>' +
        '<span class="qi-sub">' + esc(a.artist) + (a.year ? ' · ' + esc(a.year) : '') + '</span></span>' +
        '<span class="qi-kind">Album</span></div>';
    }).join('');
  }
  html += '<button class="quick-all" data-quick-all>Vedi tutti i risultati per "' + esc(query) + '"</button>';

  box.innerHTML = html;
  box.classList.remove('hidden');
  positionQuickBox();
  $('#searchInput').setAttribute('aria-expanded', 'true');
  quick.open = true;
}

function gotoQuickItem(item) {
  if (!item) return;
  closeQuickSearch();
  location.hash = item.type === 'artista'
    ? '#/artista/' + encodeURIComponent(item.name)
    : '#/album/' + encodeURIComponent(item.id);
}

function gotoFullSearch() {
  const v = $('#searchInput').value.trim();
  closeQuickSearch();
  location.hash = v ? '#/cerca/' + encodeURIComponent(v) : '#/';
}

let searchTimer;
$('#searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderQuickSearch($('#searchInput').value), 120);
});

$('#searchInput').addEventListener('focus', () => {
  if ($('#searchInput').value.trim()) renderQuickSearch($('#searchInput').value);
});

$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!quick.open) { renderQuickSearch($('#searchInput').value); return; }
    if (quick.items.length) {
      quick.active = (quick.active + 1) % quick.items.length;
      highlightQuick();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (quick.open && quick.items.length) {
      quick.active = (quick.active - 1 + quick.items.length) % quick.items.length;
      highlightQuick();
    }
  } else if (e.key === 'Enter') {
    if (quick.open && quick.active >= 0) {
      e.preventDefault();
      gotoQuickItem(quick.items[quick.active]);
    } else {
      gotoFullSearch();
    }
  } else if (e.key === 'Escape') {
    if (quick.open) { e.stopPropagation(); closeQuickSearch(); }
  }
});

// mousedown, non click: agisce prima che l'input perda il focus
$('#quickResults').addEventListener('mousedown', (e) => {
  e.preventDefault();
  if (e.target.closest('[data-quick-all]')) { gotoFullSearch(); return; }
  const item = e.target.closest('[data-quick-idx]');
  if (item) gotoQuickItem(quick.items[+item.dataset.quickIdx]);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap') && !e.target.closest('#quickResults')) closeQuickSearch();
});

window.addEventListener('resize', () => { if (quick.open) positionQuickBox(); });

/* ---------------- Import ---------------- */

const AUDIO_RE = /\.(mp3|flac|m4a|ogg|oga|wav|aac|opus)$/i;
let upFiles = [];
let impPath = '';

function joinPath(base, name) {
  if (!base) return name;
  return base.replace(/[\\/]+$/, '') + '/' + name;
}

async function refreshLibrary() {
  const r = await api('/api/albums?force=1');
  state.albums = r.albums;
  renderPlaylists();
  router();
}

function openImportModal() {
  $('#importModal').classList.remove('hidden');
  switchTab('disk');
  api('/api/drives').then((r) => {
    $('#impDrives').innerHTML = r.drives
      .map((d) => '<button class="drive-btn" data-drive="' + esc(d.path) + '">' + esc(d.label) + '</button>')
      .join('');
  }).catch(() => {});
  loadDirs('');
}

function switchTab(name) {
  document.querySelectorAll('#importModal .tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tab === name));
  $('#tab-disk').classList.toggle('hidden', name !== 'disk');
  $('#tab-upload').classList.toggle('hidden', name !== 'upload');
  $('#tab-sources').classList.toggle('hidden', name !== 'sources');
  if (name === 'upload') renderUpload();
  if (name === 'sources') renderSources();
}

function descriviCache(s) {
  const parti = [];
  if (s.cachedTracks) parti.push(s.cachedTracks + (s.cachedTracks === 1 ? ' brano' : ' brani') + ' in cache');
  if (s.cachedFeatures) parti.push(s.cachedFeatures + ' analizzati');
  return parti.join(', ');
}

async function renderSources() {
  const box = $('#srcList');
  $('#srcResult').innerHTML = '';
  box.innerHTML = '<div class="hint" style="padding:12px;">Lettura in corso...</div>';
  try {
    const r = await api('/api/sources');
    if (!r.sources.length) {
      box.innerHTML = '<div style="padding:14px;color:#666;text-align:center;">Nessuna cartella indicizzata</div>';
      return;
    }
    box.innerHTML = r.sources.map((s) =>
      '<div class="dir-row">' +
        '<span class="d-name static" title="' + esc(s.path) + '">' +
          (s.available ? '' : '<span class="badge warn">non collegata</span>') +
          esc(s.path) +
        '</span>' +
        '<span class="d-count">' + esc(descriviCache(s)) + '</span>' +
        '<button class="btn small ghost" data-rm-source="' + esc(s.path) + '">Rimuovi</button>' +
        '<button class="btn small ghost" data-forget-source="' + esc(s.path) + '">Dimentica</button>' +
      '</div>').join('');
  } catch (err) {
    box.innerHTML = '';
    $('#srcResult').innerHTML = '<div class="err">' + esc(err.message) + '</div>';
  }
}

async function removeSource(dir, forget) {
  const box = $('#srcResult');
  box.innerHTML = '<div class="hint">Operazione in corso...</div>';
  try {
    const r = await api('/api/sources?path=' + encodeURIComponent(dir) +
      (forget ? '&forget=1' : ''), { method: 'DELETE' });
    const esito = r.forgotten
      ? 'Dimenticata: metadati ' + r.voci + ', analisi audio ' + r.analisi +
        ', copertine ' + r.copertine + ' (' + (r.byte / 1048576).toFixed(1) + ' MB liberati)'
      : 'Cartella tolta dall\'elenco; i metadati restano in cache';
    // renderSources() ripulisce il riquadro, quindi il messaggio va scritto dopo.
    await renderSources();
    box.innerHTML = '<div class="ok">' + esc(esito) + '</div>';
    await refreshLibrary();
  } catch (err) {
    box.innerHTML = '<div class="err">' + esc(err.message) + '</div>';
  }
}

async function loadDirs(dir) {
  const q = dir ? '?path=' + encodeURIComponent(dir) : '';
  try {
    const r = await api('/api/dirs' + q);
    impPath = r.path;
    $('#impPath').value = r.path;
    $('#impResult').innerHTML = '';
    const rows = [];
    if (r.parent) {
      rows.push('<div class="dir-row"><button class="d-name" data-dir="' + esc(r.parent) + '">.. (cartella superiore)</button></div>');
    }
    for (const d of r.dirs) {
      const full = joinPath(r.path, d.name);
      rows.push('<div class="dir-row">' +
        '<button class="d-name" data-dir="' + esc(full) + '">' +
        (d.album ? '<span class="badge">album</span>' : '') + esc(d.name) + '</button>' +
        '<span class="d-count">' + (d.audioCount ? d.audioCount + ' audio' : '') + '</span>' +
        (d.album
          ? '<button class="btn small" data-index-dir="' + esc(full) + '">Indicizza</button>'
          : '') +
        '</div>');
    }
    $('#impDirs').innerHTML = rows.length ? rows.join('') : '<div style="padding:14px;color:#666;text-align:center;">Cartella vuota</div>';
  } catch (err) {
    $('#impDirs').innerHTML = '';
    $('#impResult').innerHTML = '<div class="err">' + esc(err.message) + '</div>';
  }
}

async function indexPath(dir) {
  const box = $('#impResult');
  box.innerHTML = '<div class="hint">Indicizzazione in corso...</div>';
  try {
    const r = await api('/api/import-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir })
    });
    let html = '<div class="ok">' +
      (r.alreadyRegistered ? 'Cartella già indicizzata' : 'Cartella aggiunta alla biblioteca') +
      ': ' + r.count + ' album</div>';
    html += '<ul>' + r.indexed.map((album) =>
      '<li>' + esc(album.artist) + ' — ' + esc(album.title) + '</li>'
    ).join('') + '</ul>';
    box.innerHTML = html;
    await refreshLibrary();
    toast(r.count + ' album indicizzati senza copiarli');
  } catch (err) {
    box.innerHTML = '<div class="err">' + esc(err.message) + '</div>';
  }
}

function renderUpload() {
  const total = upFiles.reduce((s, f) => s + f.size, 0);
  $('#upStartBtn').textContent = 'Importa' + (upFiles.length ? ' ' + upFiles.length + ' file' : '');
  $('#upStartBtn').disabled = !upFiles.length;
  const dz = $('#dropZone');
  if (upFiles.length) {
    dz.innerHTML = '<div class="dz-ok"><strong>' + upFiles.length + ' file pronti</strong>' +
      '<span class="hint">' + (total / 1048576).toFixed(1) + ' MB</span>' +
      '<button class="dz-clear">rimuovi la selezione</button></div>';
  } else {
    dz.innerHTML = '<strong>Trascina qui cartelle o file audio</strong>' +
      '<div class="dz-btns"><button id="pickFolder" class="btn small">Scegli cartella</button>' +
      '<button id="pickFiles" class="btn small ghost">Scegli file</button></div>' +
      '<div class="hint">formati: mp3, flac, m4a, ogg, wav, aac, opus</div>';
    $('#pickFolder').addEventListener('click', () => $('#fileFolder').click());
    $('#pickFiles').addEventListener('click', () => $('#fileFiles').click());
  }
  $('#upText').textContent = '';
}

function addFiles(files) {
  if (!files || !files.length) return;
  const out = [];
  let top = null;
  for (const f of files) {
    let rel = f._rel || f.webkitRelativePath || '';
    if (rel) {
      const parts = rel.split('/').filter(Boolean);
      if (parts.length > 1) {
        if (!top) top = parts[0];
        parts.shift();
        rel = parts.join('/');
      } else {
        rel = parts[0] || '';
      }
    }
    f._rel = rel || f.name;
    if (AUDIO_RE.test(f.name)) out.push(f);
  }
  upFiles = upFiles.concat(out);
  const target = $('#upAlbum');
  if (top && (!target.value || target.value === 'Album importato')) target.value = top;
  renderUpload();
}

function uploadOne(file, rel, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?rel=' + encodeURIComponent(rel));
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error((xhr.response && xhr.response.error) || 'Errore ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('Errore di rete'));
    xhr.send(file);
  });
}

async function startUpload() {
  const target = $('#upAlbum').value.trim() || 'Album importato';
  const files = upFiles;
  if (!files.length) return;
  const total = files.reduce((s, f) => s + f.size, 0);
  let acc = 0;
  $('#upStartBtn').disabled = true;
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      $('#upText').textContent = 'Caricamento ' + (i + 1) + '/' + files.length + ' — ' + f.name;
      await uploadOne(f, joinPath(target, f._rel), (p) => {
        $('#upBarFill').style.width = Math.round(((acc + p) / total) * 100) + '%';
      });
      acc += f.size;
    }
    $('#upText').textContent = 'Fatto! ' + files.length + ' file caricati';
    $('#upBarFill').style.width = '100%';
    upFiles = [];
    renderUpload();
    await refreshLibrary();
    toast('Upload completato');
  } catch (err) {
    $('#upText').textContent = 'Errore: ' + err.message;
  } finally {
    $('#upStartBtn').disabled = !upFiles.length;
  }
}

$('#importBtn').addEventListener('click', openImportModal);
$('#importClose').addEventListener('click', () => $('#importModal').classList.add('hidden'));
$('#importModal').addEventListener('click', (e) => {
  if (e.target === $('#importModal')) $('#importModal').classList.add('hidden');
});

document.querySelectorAll('#importModal .tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

$('#impGo').addEventListener('click', () => loadDirs($('#impPath').value.trim()));
$('#impPath').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadDirs($('#impPath').value.trim());
});

$('#impAllBtn').addEventListener('click', () => impPath && indexPath(impPath));

$('#srcList').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm-source]');
  if (rm) {
    const dir = rm.dataset.rmSource;
    if (confirm('Togliere "' + dir + '" dalle cartelle indicizzate?\n\nI file musicali non vengono toccati e i metadati restano in cache.')) {
      removeSource(dir, false);
    }
    return;
  }
  const forget = e.target.closest('[data-forget-source]');
  if (forget) {
    const dir = forget.dataset.forgetSource;
    if (confirm('Dimenticare "' + dir + '"?\n\nOltre a toglierla dall\'elenco vengono cancellati i metadati letti e le copertine rimaste senza album. I file musicali non vengono toccati, ma se un giorno reinserisci la cartella andrà riletta da capo.')) {
      removeSource(dir, true);
    }
  }
});

document.addEventListener('click', (e) => {
  const drive = e.target.closest('[data-drive]');
  if (drive) {
    loadDirs(drive.dataset.drive);
    return;
  }
  const d = e.target.closest('[data-dir]');
  if (d) {
    loadDirs(d.dataset.dir);
    return;
  }
  const imp = e.target.closest('[data-index-dir]');
  if (imp) {
    indexPath(imp.dataset.indexDir);
    return;
  }
  const clear = e.target.closest('.dz-clear');
  if (clear) {
    upFiles = [];
    renderUpload();
  }
});

$('#fileFolder').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});
$('#fileFiles').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});

const dropZone = $('#dropZone');
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('over');
  const items = e.dataTransfer.items;
  if (items && items.length && items[0].webkitGetAsEntry) {
    const out = [];
    let pending = 0;
    const done = () => {
      if (--pending === 0) addFiles(out);
    };
    const collect = (entry, prefix) => {
      if (entry.isFile) {
        pending++;
        entry.file(
          (f) => { f._rel = prefix ? prefix + '/' + entry.name : entry.name; out.push(f); done(); },
          done
        );
      } else if (entry.isDirectory) {
        pending++;
        const reader = entry.createReader();
        const readBatch = () => {
          reader.readEntries((ents) => {
            if (!ents.length) { done(); return; }
            ents.forEach((se) => collect(se, prefix ? prefix + '/' + entry.name : entry.name));
            readBatch();
          }, done);
        };
        readBatch();
      }
    };
    for (const it of items) {
      const entry = it.webkitGetAsEntry();
      if (entry) collect(entry, '');
    }
  } else if (e.dataTransfer.files.length) {
    addFiles(e.dataTransfer.files);
  }
});

$('#upStartBtn').addEventListener('click', startUpload);

document.querySelectorAll('.nav-btn').forEach((b) => {
  if (!b.dataset.route) return;
  b.addEventListener('click', () => {
    location.hash = b.dataset.route === 'home' ? '#/' : '#/' + b.dataset.route;
  });
});

audio.addEventListener('timeupdate', () => {
  if (!state.isSeeking) {
    $('#seek').value = audio.duration ? Math.round((audio.currentTime / audio.duration) * 1000) : 0;
  }
  $('#cur').textContent = fmt(audio.currentTime);
  syncLyrics(false);
  // Un ascolto conta dopo 30 secondi o metà brano, quello che arriva prima.
  if (!state.playCounted && state.current && audio.duration) {
    const soglia = Math.min(30, audio.duration / 2);
    if (audio.currentTime >= soglia) {
      state.playCounted = true;
      countPlay(state.current);
    }
  }
});

audio.addEventListener('loadedmetadata', () => {
  $('#dur').textContent = fmt(audio.duration);
});

audio.addEventListener('play', updatePlayerUI);
audio.addEventListener('pause', updatePlayerUI);

audio.addEventListener('ended', () => {
  if (state.repeat === 2) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (state.shuffle || state.pos + 1 < state.queue.length || state.repeat === 1) {
    nextTrack();
  } else {
    state.pos = -1;
    state.current = null;
    updatePlayerUI();
  }
});

// Un file irraggiungibile (disco scollegato, album spostato) non deve fermare la
// coda: si passa al brano seguente. Il contatore evita di rimbalzare all'infinito
// quando a mancare e' l'intera cartella, e si azzera appena un brano parte davvero.
let failedInARow = 0;

audio.addEventListener('playing', () => {
  failedInARow = 0;
});

audio.addEventListener('error', () => {
  if (!state.current) return;
  toast('Impossibile riprodurre: ' + state.current.title);
  failedInARow++;
  if (failedInARow >= Math.min(state.queue.length || 1, 10)) {
    failedInARow = 0;
    state.pos = -1;
    state.current = null;
    audio.pause();
    audio.removeAttribute('src');
    updatePlayerUI();
    toast('Riproduzione interrotta: i file non sono raggiungibili');
    return;
  }
  nextTrack();
});

$('#seek').addEventListener('input', (e) => {
  state.isSeeking = true;
  $('#cur').textContent = fmt((e.target.value / 1000) * (audio.duration || 0));
});

$('#seek').addEventListener('change', (e) => {
  audio.currentTime = (e.target.value / 1000) * (audio.duration || 0);
  state.isSeeking = false;
});

$('#vol').addEventListener('input', (e) => {
  state.volume = Math.max(0, Math.min(1, +e.target.value || 0));
  applyVolume();
  audio.muted = false;
  $('#volBtn').classList.remove('active');
  localStorage.setItem('sd_volume', String(state.volume));
});

$('#volBtn').addEventListener('click', () => {
  audio.muted = !audio.muted;
  $('#volBtn').classList.toggle('active', audio.muted);
});

// Controlli del taglio. Cambiando modalita' si ridisegna solo la riga: ridisegnare
// tutta la vista farebbe perdere il fuoco mentre si digitano gli anni.
document.addEventListener('change', (e) => {
  if (e.target.id === 'radioMode') {
    state.radioChoice.mode = e.target.value;
    state.radioError = '';
    const riga = $('#radioCut');
    if (riga) riga.innerHTML = renderRadioCut();
    return;
  }
  if (e.target.id === 'radioGenre') state.radioChoice.genre = e.target.value;
  if (e.target.id === 'radioDecade') state.radioChoice.decade = e.target.value;
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'radioYearMin') state.radioChoice.yearMin = e.target.value;
  if (e.target.id === 'radioYearMax') state.radioChoice.yearMax = e.target.value;
  if (e.target.id === 'radioTheme') state.radioChoice.theme = e.target.value;
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'radioTheme' && e.key === 'Enter') {
    e.preventDefault();
    generateRadioEpisode();
    return;
  }
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  }
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play().catch(() => {}));
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
  navigator.mediaSession.setActionHandler('nexttrack', nextTrack);
}

window.addEventListener('hashchange', router);

/* ---------------- Init ---------------- */

(async function init() {
  const saved = localStorage.getItem('sd_volume');
  if (saved !== null && Number.isFinite(+saved)) {
    state.volume = Math.max(0, Math.min(1, +saved));
    $('#vol').value = String(state.volume);
  }
  applyVolume();
  try {
    const [albums, playlists, stats, radio] = await Promise.all([
      api('/api/albums'),
      api('/api/playlists'),
      api('/api/stats').catch(() => ({ albums: {}, tracks: {} })),
      api('/api/radio/episodes').catch(() => ({ episodes: [] }))
    ]);
    state.albums = albums.albums;
    state.playlists = playlists.playlists;
    state.stats = { albums: stats.albums || {}, tracks: stats.tracks || {} };
    state.radioEpisodes = radio.episodes || [];
    renderPlaylists();
  } catch (err) {
    toast('Errore di connessione: ' + err.message);
  }
  router();
})();

})();
