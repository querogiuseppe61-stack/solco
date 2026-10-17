'use strict';

// Test d'integrazione: il server vero, avviato su una copia dell'app con una
// libreria di prova, interrogato via HTTP come fa l'interfaccia.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { avviaApp, wav, JPEG_FINTO, scriviFile, aspetta } = require('./helpers');

const LRC = '[ar:Artista Uno]\n[offset:+500]\n[00:01.00][00:05.50]Ritornello\n[00:03.00]Strofa\nriga senza tempo\n';

describe('server', () => {
  let app;
  let albums;
  const album = (titolo) => albums.find((a) => a.title === titolo);
  const ricarica = async () => {
    albums = (await app.get('/api/albums?force=1')).json().albums;
  };

  before(async () => {
    app = await avviaApp({
      musica: {
        'Artista Uno - Primo Album (1999)/02 - Secondo.wav': wav(3),
        'Artista Uno - Primo Album (1999)/01 - Primo.wav': wav(2),
        'Artista Uno - Primo Album (1999)/10 - Decimo.wav': wav(1),
        // stub AppleDouble di macOS: stessa estensione, nessun audio
        'Artista Uno - Primo Album (1999)/._01 - Primo.wav': 'non audio',
        'Artista Uno - Primo Album (1999)/01 - Primo.lrc': LRC,
        'Artista Uno - Primo Album (1999)/cover.jpg': JPEG_FINTO,
        'Gruppo Due/Album Annidato/01 - Brano.wav': wav(1),
        // "cover.jpg" che JPEG non e': va ignorata
        'Gruppo Due/Album Annidato/cover.jpg': 'testo qualsiasi',
        'Terzo - Raccolta (2005)/01 - Uno.wav': wav(2),
        'Terzo - Raccolta (2005)/02 - Due.wav': wav(2),
        'Terzo - Raccolta (2005)/03 - Tre.wav': wav(2),
        'Terzo - Raccolta (2005)/04 - Quattro.wav': wav(2),
        'Terzo - Raccolta (2005)/05 - Cinque.wav': wav(2),
        'Terzo - Raccolta (2005)/06 - Sei.wav': wav(2)
      }
    });
    await ricarica();
  });

  after(async () => {
    if (app) await app.ferma();
  });

  describe('indicizzazione', () => {
    it('trova gli album e ne ricava artista, titolo e anno', () => {
      assert.equal(albums.length, 3);
      const primo = album('Primo Album');
      assert.equal(primo.artist, 'Artista Uno');
      assert.equal(primo.year, 1999);
      assert.equal(primo.external, false);
    });

    it('usa la cartella madre come artista per gli album annidati', () => {
      assert.equal(album('Album Annidato').artist, 'Gruppo Due');
    });

    it('ordina i brani in ordine naturale, pulisce i titoli e ignora i file "._"', () => {
      const brani = album('Primo Album').tracks;
      assert.deepEqual(brani.map((t) => t.file), ['01 - Primo.wav', '02 - Secondo.wav', '10 - Decimo.wav']);
      assert.deepEqual(brani.map((t) => t.title), ['Primo', 'Secondo', 'Decimo']);
      assert.equal(Math.round(brani[1].duration), 3);
    });

    it('riconosce le copertine dal contenuto, non dall\'estensione', () => {
      assert.equal(album('Primo Album').cover, true);
      assert.equal(album('Album Annidato').cover, false);
    });
  });

  describe('sicurezza delle richieste', () => {
    it('rifiuta un header Host che non e\' locale (DNS rebinding)', async () => {
      assert.equal((await app.get('/api/albums', { Host: 'evil.example' })).status, 403);
      assert.equal((await app.get('/api/albums', { Host: '127.0.0.1:abc' })).status, 403);
    });

    it('accetta gli indirizzi locali, IPv6 compreso', async () => {
      assert.equal((await app.get('/api/albums', { Host: 'localhost:' + app.porta })).status, 200);
      assert.equal((await app.get('/api/albums', { Host: '[::1]:' + app.porta })).status, 200);
    });

    it('rifiuta le origini estranee e quella "null" degli iframe in sandbox', async () => {
      assert.equal((await app.get('/api/albums', { Origin: 'http://evil.example' })).status, 403);
      assert.equal((await app.get('/api/albums', { Origin: 'null' })).status, 403);
      assert.equal((await app.get('/api/albums', { Origin: 'http://localhost:' + app.porta })).status, 200);
    });

    it('per le API accetta solo Sec-Fetch-Site same-origin o none', async () => {
      assert.equal((await app.get('/api/albums', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await app.get('/api/albums', { 'Sec-Fetch-Site': 'same-site' })).status, 403);
      assert.equal((await app.get('/api/albums', { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
      assert.equal((await app.get('/api/albums', { 'Sec-Fetch-Site': 'none' })).status, 200);
      // le pagine statiche restano raggiungibili
      assert.equal((await app.get('/', { 'Sec-Fetch-Site': 'cross-site' })).status, 200);
    });

    it('risponde 400 a un URL malformato invece di cadere', async () => {
      assert.equal((await app.get('//')).status, 400);
      assert.equal((await app.get('/api/albums')).status, 200);
    });

    it('non esce dalla cartella public', async () => {
      assert.equal((await app.get('/public/../server.js')).status, 404);
      assert.equal((await app.get('/public/%2e%2e/server.js')).status, 404);
      assert.equal((await app.get('/public/..%2fserver.js')).status, 403);
      assert.equal((await app.get('/public/%00')).status, 400);
      const css = await app.get('/public/style.css');
      assert.equal(css.status, 200);
      assert.match(css.headers['content-type'], /text\/css/);
    });

    it('vuole corpi JSON veri, di dimensione ragionevole', async () => {
      const testo = await app.richiesta({
        method: 'POST', path: '/api/playlists', body: '{"name":"x"}', headers: { 'Content-Type': 'text/plain' }
      });
      assert.equal(testo.status, 415);
      const rotto = await app.richiesta({
        method: 'POST', path: '/api/playlists', body: '{nome', headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(rotto.status, 400);
      const enorme = await app.richiesta({
        method: 'POST', path: '/api/playlists', body: Buffer.alloc(3 * 1024 * 1024, 32),
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(enorme.status, 413);
    });
  });

  describe('streaming', () => {
    const percorso = () => '/api/stream?id=' + encodeURIComponent(album('Primo Album').id) + '&i=0';
    const dimensione = wav(2).length;

    it('invia il file intero', async () => {
      const r = await app.get(percorso());
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'audio/wav');
      assert.equal(r.headers['accept-ranges'], 'bytes');
      assert.equal(r.body.length, dimensione);
      assert.equal(r.body.slice(0, 4).toString(), 'RIFF');
    });

    it('rispetta le richieste Range', async () => {
      const inizio = await app.get(percorso(), { Range: 'bytes=0-9' });
      assert.equal(inizio.status, 206);
      assert.equal(inizio.body.length, 10);
      assert.equal(inizio.headers['content-range'], 'bytes 0-9/' + dimensione);

      const coda = await app.get(percorso(), { Range: 'bytes=-4' });
      assert.equal(coda.status, 206);
      assert.equal(coda.headers['content-range'], 'bytes ' + (dimensione - 4) + '-' + (dimensione - 1) + '/' + dimensione);

      const aperta = await app.get(percorso(), { Range: 'bytes=40-' });
      assert.equal(aperta.body.length, dimensione - 40);

      const oltre = await app.get(percorso(), { Range: 'bytes=0-99999999' });
      assert.equal(oltre.status, 206);
      assert.equal(oltre.body.length, dimensione);
    });

    it('risponde 416 ai Range impossibili o malformati', async () => {
      for (const range of ['bytes=99999999-', 'bytes=5-2', 'bytes=-', 'bytes=-0', 'righe=0-1', 'bytes=0-1,4-5']) {
        const r = await app.get(percorso(), { Range: range });
        assert.equal(r.status, 416, range);
        assert.equal(r.headers['content-range'], 'bytes */' + dimensione, range);
      }
    });

    it('risponde a HEAD senza corpo', async () => {
      const r = await app.richiesta({ method: 'HEAD', path: percorso() });
      assert.equal(r.status, 200);
      assert.equal(Number(r.headers['content-length']), dimensione);
      assert.equal(r.body.length, 0);
    });

    it('404 per album o brano inesistenti', async () => {
      assert.equal((await app.get('/api/stream?id=nessuno&i=0')).status, 404);
      assert.equal((await app.get('/api/stream?id=' + encodeURIComponent(album('Primo Album').id) + '&i=9')).status, 404);
      assert.equal((await app.get('/api/stream')).status, 400);
    });
  });

  describe('copertine e testi', () => {
    it('serve la copertina con ETag e risponde 304 se non e\' cambiata', async () => {
      const p = '/api/cover?id=' + encodeURIComponent(album('Primo Album').id);
      const r = await app.get(p);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'image/jpeg');
      assert.deepEqual(r.body, JPEG_FINTO);
      const ancora = await app.get(p, { 'If-None-Match': r.headers.etag });
      assert.equal(ancora.status, 304);
      assert.equal((await app.get('/api/cover?id=' + encodeURIComponent(album('Album Annidato').id))).status, 404);
    });

    it('legge i .lrc con piu\' tempi per riga e offset', async () => {
      const r = await app.get('/api/lyrics?id=' + encodeURIComponent(album('Primo Album').id) + '&i=0');
      assert.equal(r.status, 200);
      const testo = r.json();
      assert.equal(testo.synced, true);
      assert.equal(testo.source, '01 - Primo.lrc');
      // offset +500 ms: ogni tempo viene anticipato di mezzo secondo
      assert.deepEqual(testo.lines, [
        { time: 0.5, text: 'Ritornello' },
        { time: 2.5, text: 'Strofa' },
        { time: 5, text: 'Ritornello' }
      ]);
    });

    it('404 quando non c\'e\' alcun testo', async () => {
      const r = await app.get('/api/lyrics?id=' + encodeURIComponent(album('Primo Album').id) + '&i=1');
      assert.equal(r.status, 404);
    });
  });

  describe('playlist', () => {
    it('crea, riempie senza duplicati, toglie brani ed elimina', async () => {
      assert.equal((await app.invia('POST', '/api/playlists', { name: '  ' })).status, 400);
      const creata = await app.invia('POST', '/api/playlists', { name: 'Prova' });
      assert.equal(creata.status, 201);
      const id = creata.json().id;
      const primo = album('Primo Album');

      let r = await app.invia('PUT', '/api/playlist-tracks', { playlistId: id, albumId: primo.id });
      assert.equal(r.json().tracks.length, 3);
      r = await app.invia('PUT', '/api/playlist-tracks', { playlistId: id, albumId: primo.id, index: 0 });
      assert.equal(r.json().tracks.length, 3, 'un brano gia\' presente non va aggiunto di nuovo');

      r = await app.invia('PUT', '/api/playlist-tracks', {
        playlistId: id,
        tracks: [
          { albumId: album('Raccolta').id, index: 2 },
          { albumId: 'inesistente', index: 0 },
          { albumId: album('Raccolta').id, index: 99 }
        ]
      });
      assert.equal(r.json().added, 1);
      assert.equal(r.json().tracks[3].title, 'Tre');

      assert.equal((await app.invia('DELETE', '/api/playlist-tracks', { playlistId: id, position: 9 })).status, 400);
      r = await app.invia('DELETE', '/api/playlist-tracks', { playlistId: id, position: 0 });
      assert.deepEqual(r.json().tracks.map((t) => t.title), ['Secondo', 'Decimo', 'Tre']);

      const elenco = (await app.get('/api/playlists')).json().playlists;
      assert.equal(elenco.find((p) => p.id === id).tracks.length, 3);

      assert.equal((await app.invia('DELETE', '/api/playlists?id=' + id)).status, 200);
      assert.equal((await app.invia('DELETE', '/api/playlists?id=' + id)).status, 404);
    });
  });

  describe('generi, statistiche e preferiti', () => {
    it('applica e rimuove il genere scelto a mano', async () => {
      const id = album('Raccolta').id;
      const r = await app.invia('PUT', '/api/album-metadata', { albumId: id, genre: 'Jazz; Blues, jazz' });
      assert.deepEqual(r.json().genre, ['Jazz', 'Blues', 'jazz']);
      await ricarica();
      assert.equal(album('Raccolta').genreManual, true);
      assert.deepEqual(album('Raccolta').genre, ['Jazz', 'Blues', 'jazz']);

      await app.invia('DELETE', '/api/album-metadata?id=' + encodeURIComponent(id));
      await ricarica();
      assert.equal(album('Raccolta').genreManual, false);
      assert.equal((await app.invia('PUT', '/api/album-metadata', { albumId: 'nessuno', genre: 'x' })).status, 404);
    });

    it('conta gli ascolti e ricorda i preferiti', async () => {
      const id = album('Primo Album').id;
      await app.invia('POST', '/api/stats/play', { albumId: id, index: 1 });
      const r = await app.invia('POST', '/api/stats/play', { albumId: id, index: 1 });
      assert.equal(r.json().album.plays, 2);
      await app.invia('PUT', '/api/stats/favorite', { albumId: id, favorite: true });
      const stats = (await app.get('/api/stats')).json();
      assert.equal(stats.albums[id].favorite, true);
      assert.equal(stats.tracks[id + '|1'].plays, 2);
      assert.equal((await app.invia('POST', '/api/stats/play', { albumId: '../x' })).status, 400);
    });
  });

  describe('caricamento in music/', () => {
    it('salva il file e lo rende subito disponibile', async () => {
      const r = await app.richiesta({
        method: 'POST',
        path: '/api/upload?rel=' + encodeURIComponent('Caricato - Nuovo (2021)/01 - Su.wav'),
        body: wav(1)
      });
      assert.equal(r.status, 200);
      await ricarica();
      assert.equal(album('Nuovo').artist, 'Caricato');
    });

    it('rifiuta i percorsi che escono da music/ o non sono validi', async () => {
      for (const rel of ['../fuori.wav', 'a/../../b.wav', 'a/b:c.wav', '']) {
        const r = await app.richiesta({ method: 'POST', path: '/api/upload?rel=' + encodeURIComponent(rel), body: 'x' });
        assert.equal(r.status, 400, rel);
      }
    });

    it('un invio interrotto non lascia file troncati', async () => {
      const cartella = path.join(app.dir, 'music', 'Interrotto - Parziale');
      await new Promise((resolve) => {
        const req = http.request({
          host: '127.0.0.1',
          port: app.porta,
          method: 'POST',
          path: '/api/upload?rel=' + encodeURIComponent('Interrotto - Parziale/01 - x.wav'),
          headers: { 'Content-Length': 1000000 }
        });
        req.on('error', () => {});
        req.write(Buffer.alloc(50000, 1), () => setTimeout(() => {
          req.destroy();
          resolve();
        }, 200));
      });
      await aspetta(() => fs.existsSync(cartella) && fs.readdirSync(cartella).length === 0, 5000,
        'il file parziale doveva sparire');
    });
  });

  describe('cartelle esterne', () => {
    let esterna;

    before(() => {
      esterna = path.join(app.dir, 'altrove');
      scriviFile(esterna, { 'Esterno - Lontano (2020)/01 - Via.wav': wav(1) });
    });

    it('indicizza una cartella fuori da music/ e la ricorda', async () => {
      assert.equal((await app.invia('POST', '/api/import-path', { path: path.join(esterna, 'manca') })).status, 404);
      assert.equal((await app.invia('POST', '/api/import-path', { path: path.join(app.dir, 'music') })).status, 400);

      const r = await app.invia('POST', '/api/import-path', { path: esterna });
      assert.equal(r.status, 200);
      assert.equal(r.json().count, 1);
      assert.equal(r.json().alreadyRegistered, false);
      assert.equal((await app.invia('POST', '/api/import-path', { path: esterna })).json().alreadyRegistered, true);

      await ricarica();
      const lontano = album('Lontano');
      assert.equal(lontano.external, true);
      assert.match(lontano.id, /^ext-[0-9a-f]{32}$/);

      const sorgenti = (await app.get('/api/sources')).json().sources;
      assert.equal(sorgenti.length, 1);
      assert.equal(sorgenti[0].available, true);
      assert.equal(sorgenti[0].cachedTracks, 1);
    });

    it('la toglie e, con forget, ne dimentica i metadati', async () => {
      const sorgente = (await app.get('/api/sources')).json().sources[0].path;
      const r = await app.invia('DELETE', '/api/sources?forget=1&path=' + encodeURIComponent(sorgente));
      assert.equal(r.status, 200);
      assert.equal(r.json().voci, 1);
      await ricarica();
      assert.equal(album('Lontano'), undefined);
      assert.equal((await app.invia('DELETE', '/api/sources?path=' + encodeURIComponent(sorgente))).status, 404);
    });

    it('sfoglia le cartelle segnalando quelle con audio', async () => {
      const r = (await app.get('/api/dirs?path=' + encodeURIComponent(path.join(app.dir, 'music')))).json();
      const primo = r.dirs.find((d) => d.name === 'Artista Uno - Primo Album (1999)');
      assert.equal(primo.album, true);
      assert.equal(primo.audioCount, 3);
      assert.equal(r.dirs.find((d) => d.name === 'Gruppo Due').album, false);
      assert.equal((await app.get('/api/dirs?path=' + encodeURIComponent(path.join(app.dir, 'manca')))).status, 400);
    });
  });

  describe('funzioni IA senza modello', () => {
    it('lo stato dice che il modello non c\'e\'', async () => {
      const stato = (await app.get('/api/ai/status')).json();
      assert.equal(stato.available, false);
      assert.equal(stato.provider, 'LM Studio');
    });

    it('la playlist IA spiega perche\' non si puo\' fare', async () => {
      const r = await app.invia('POST', '/api/ai/playlist', { prompt: 'rock' });
      assert.equal(r.status, 422);
      assert.match(r.json().error, /LM Studio/);
    });

    it('Radio Solco monta comunque una puntata, e la ricorda', async () => {
      assert.equal((await app.invia('POST', '/api/radio/episode', { mode: 'theme', theme: ' ' })).status, 400);

      const r = await app.invia('POST', '/api/radio/episode', {});
      assert.equal(r.status, 201);
      const ep = r.json().episode;
      assert.ok(ep.tracks.length >= 8);
      assert.equal(ep.ai.used, false);
      assert.equal(new Set(ep.tracks.map((t) => t.albumId + '|' + t.index)).size, ep.tracks.length);

      const suonata = await app.invia('PUT', '/api/radio/episode-played', { id: ep.id });
      assert.equal(suonata.json().episode.playCount, 1);
      assert.equal((await app.get('/api/radio/episodes')).json().episodes.length, 1);
      assert.equal((await app.invia('DELETE', '/api/radio/episodes?id=' + ep.id)).status, 200);
      assert.equal((await app.invia('DELETE', '/api/radio/episodes?id=' + ep.id)).status, 404);
    });
  });

  describe('impostazioni IA', () => {
    it('salva la chiave fuori dalla cartella dell\'app e non la restituisce', async () => {
      const r = await app.invia('PUT', '/api/ai/config', {
        provider: 'openrouter', openRouterModel: 'modello/prova', openRouterKey: 'sk-segreta'
      });
      assert.equal(r.status, 200);
      assert.equal(r.json().hasOpenRouterKey, true);
      assert.ok(!r.text().includes('sk-segreta'));

      const credenziali = path.join(app.dir, '_config', 'credentials.json');
      assert.equal(JSON.parse(fs.readFileSync(credenziali, 'utf8')).openRouterKey, 'sk-segreta');
      if (process.platform !== 'win32') assert.equal(fs.statSync(credenziali).mode & 0o777, 0o600);
      const impostazioni = fs.readFileSync(path.join(app.dir, 'ai-config.json'), 'utf8');
      assert.ok(!impostazioni.includes('sk-segreta'));

      // senza chiave nel corpo quella salvata resta
      await app.invia('PUT', '/api/ai/config', { provider: 'openrouter', openRouterModel: 'altro' });
      const letta = (await app.get('/api/ai/config')).json();
      assert.equal(letta.hasOpenRouterKey, true);
      assert.equal(letta.openRouterModel, 'altro');

      const stato = (await app.get('/api/ai/status')).json();
      assert.equal(stato.available, true);
      assert.equal(stato.provider, 'OpenRouter');
    });
  });
});
