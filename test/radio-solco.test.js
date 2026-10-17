'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRadioSolcoService, signatureOf } = require('../radio-solco');

// Dieci artisti da sei brani di quattro minuti: cinque Rock anni '70, cinque
// Jazz anni '90. Abbastanza per ogni taglio di una puntata da 45 minuti.
function libreria() {
  const albums = [];
  for (let a = 0; a < 10; a++) {
    const jazz = a >= 5;
    albums.push({
      id: 'a' + a,
      artist: 'Artista ' + a,
      title: 'Disco ' + a,
      year: jazz ? 1990 + a : 1970 + a,
      genre: [jazz ? 'Jazz' : 'Rock'],
      cover: false,
      tracks: Array.from({ length: 6 }, (_, i) => ({
        i,
        // i primi due brani dei dischi pari parlano di notte
        title: a % 2 === 0 && i < 2 ? 'Notte ' + a + '-' + i : 'Brano ' + a + '-' + i,
        duration: 240
      }))
    });
  }
  return albums;
}

const MIN = 38 * 60;
const MAX = 52 * 60;
const durata = (ep) => ep.tracks.reduce((s, t) => s + t.duration, 0);
const perArtista = (ep) => {
  const n = new Map();
  for (const t of ep.tracks) n.set(t.artist, (n.get(t.artist) || 0) + 1);
  return Math.max(...n.values());
};

function controllaPuntata(ep) {
  assert.ok(durata(ep) >= MIN && durata(ep) <= MAX, 'durata ' + durata(ep));
  assert.ok(perArtista(ep) <= 3, 'troppi brani dello stesso artista');
  assert.equal(new Set(ep.tracks.map((t) => t.albumId + '|' + t.index)).size, ep.tracks.length, 'brani ripetuti');
  assert.equal(ep.signature, signatureOf(ep.tracks));
}

describe('Radio Solco', () => {
  it('senza modello monta una puntata valida dal server', async () => {
    const r = await createRadioSolcoService({ webInfo: null }).produce(libreria(), {});
    assert.equal(r.ok, true);
    controllaPuntata(r.episode);
    assert.equal(r.episode.ai.used, false);
    assert.equal(r.episode.chosenBy, 'ia');
    assert.ok(r.episode.title);
  });

  it('rifiuta una libreria troppo piccola', async () => {
    const piccola = libreria().slice(0, 1);
    const r = await createRadioSolcoService({ webInfo: null }).produce(piccola, {});
    assert.equal(r.ok, false);
  });

  it('il genere chiesto dall\'ascoltatore viene rispettato', async () => {
    const r = await createRadioSolcoService({ webInfo: null }).produce(libreria(), {
      request: { mode: 'genre', genre: 'jazz' }
    });
    assert.equal(r.ok, true);
    controllaPuntata(r.episode);
    assert.equal(r.episode.criteria.genre, 'Jazz');
    assert.equal(r.episode.chosenBy, 'utente');
    const jazz = new Set(libreria().filter((a) => a.genre[0] === 'Jazz').map((a) => a.id));
    assert.ok(r.episode.tracks.every((t) => jazz.has(t.albumId)));
  });

  it('il decennio chiesto viene rispettato', async () => {
    const r = await createRadioSolcoService({ webInfo: null }).produce(libreria(), {
      request: { mode: 'decade', yearMin: 1974 }
    });
    assert.deepEqual([r.episode.criteria.yearMin, r.episode.criteria.yearMax], [1970, 1979]);
    assert.ok(r.episode.tracks.every((t) => t.year >= 1970 && t.year <= 1979));
  });

  it('un genere che non esiste ripiega su una selezione libera, e lo dice', async () => {
    const r = await createRadioSolcoService({ webInfo: null }).produce(libreria(), {
      request: { mode: 'genre', genre: 'Polka' }
    });
    assert.equal(r.episode.mode, 'random');
    assert.ok(r.episode.warnings.some((w) => w.includes('non era applicabile')));
  });

  it('non ripete una scaletta gia\' trasmessa', async () => {
    const radio = createRadioSolcoService({ webInfo: null });
    const prima = (await radio.produce(libreria(), { request: { mode: 'genre', genre: 'Rock' } })).episode;
    for (let i = 0; i < 5; i++) {
      const dopo = (await radio.produce(libreria(), {
        request: { mode: 'genre', genre: 'Rock' },
        avoidSignatures: [prima.signature]
      })).episode;
      assert.notEqual(dopo.signature, prima.signature);
    }
  });

  it('un tema scritto dall\'ascoltatore senza modello non si puo\' fare', async () => {
    const r = await createRadioSolcoService({ webInfo: null }).produce(libreria(), {
      request: { mode: 'theme', theme: 'la notte' }
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /modello linguistico/);
  });

  it('con il modello: il tema diventa parole chiave e la scaletta parte dai brani a tema', async () => {
    const chiamate = [];
    const webInfo = {
      async chatJSON(sistema, utente) {
        chiamate.push(utente);
        if (chiamate.length === 1) {
          return {
            ok: true,
            provider: 'LM Studio',
            model: 'finto',
            data: { mode: 'mixed', keywords: ['notte', 'la', 'musica'], title: 'Notturni', description: 'Brani per la notte.' }
          };
        }
        return { ok: true, provider: 'LM Studio', model: 'finto', data: { chosen: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] } };
      }
    };
    const r = await createRadioSolcoService({ webInfo }).produce(libreria(), {
      request: { mode: 'theme', theme: 'la notte' }
    });
    assert.equal(r.ok, true, r.error);
    const ep = r.episode;
    assert.equal(ep.title, 'Notturni');
    assert.equal(ep.requestedTheme, 'la notte');
    // le parole troppo corte o generiche vengono scartate
    assert.deepEqual(ep.criteria.keywords, ['notte']);
    assert.equal(ep.themeMatches, 10);
    assert.equal(ep.ai.used, true);
    assert.ok(ep.tracks.filter((t) => t.title.startsWith('Notte')).length >= 8);
    controllaPuntata(ep);
    assert.match(chiamate[1], /I primi 10 brani/);
  });

  it('un tema che non aggancia abbastanza brani viene rifiutato', async () => {
    const webInfo = {
      async chatJSON() {
        return { ok: true, data: { mode: 'mixed', keywords: ['pioggia'], title: 'Pioggia' } };
      }
    };
    const r = await createRadioSolcoService({ webInfo }).produce(libreria(), {
      request: { mode: 'theme', theme: 'pioggia' }
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /Nessun brano/);
  });

  it('opzioni propone solo generi e decenni con abbastanza brani', () => {
    const o = createRadioSolcoService({ webInfo: null }).opzioni(libreria());
    assert.deepEqual(o.genres.map((g) => g.nome).sort(), ['Jazz', 'Rock']);
    assert.deepEqual(o.decades.map((d) => d.decade), [1970, 1990]);
    assert.equal(o.trackCount, 60);
  });
});
