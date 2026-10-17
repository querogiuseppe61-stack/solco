'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAiPlaylistService, flattenTracks, fuzzyIncludes } = require('../ai-playlist');

// Libreria sintetica: niente file, solo gli oggetti che scan() produrrebbe.
function disco(id, artista, titolo, anno, genere, durate) {
  return {
    id,
    artist: artista,
    title: titolo,
    year: anno,
    genre: genere,
    cover: false,
    tracks: durate.map((d, i) => ({ i, title: titolo + ' ' + (i + 1), artist: null, duration: d, file: i + '.flac' }))
  };
}

const LIBRERIA = [
  disco('b1', 'The Beatles', 'Abbey Road', 1969, ['Rock'], [240, 240, 240, 240]),
  disco('b2', 'The Beatles', 'Revolver', 1966, ['Rock'], [180, 180, 180]),
  disco('m1', 'Miles Davis', 'Kind of Blue', 1959, ['Jazz'], [560, 600, 330]),
  disco('r1', 'Radiohead', 'OK Computer', 1997, ['Alternative Rock'], [280, 300, 260]),
  disco('n1', 'Nick Drake', 'Pink Moon', 1972, ['Folk'], [120, 150])
];

// webInfo finto: restituisce le risposte in coda e registra i prompt ricevuti.
function modello(...risposte) {
  const ricevuti = [];
  return {
    ricevuti,
    async chatJSON(sistema, utente) {
      ricevuti.push(utente);
      const r = risposte.shift();
      return r || { ok: false, reason: 'nessuna risposta prevista' };
    },
    async aiStatus() {
      return { provider: 'LM Studio' };
    }
  };
}
const ok = (data) => ({ ok: true, data, model: 'finto', provider: 'LM Studio' });
const piano = (web, prompt) => createAiPlaylistService({ webInfo: web }).plan(LIBRERIA, prompt);

describe('flattenTracks e fuzzyIncludes', () => {
  it('appiattisce gli album tenendo il file fuori dal JSON', () => {
    const brani = flattenTracks([{ ...LIBRERIA[3], dir: '/musica/ok' }]);
    assert.equal(brani.length, 3);
    assert.equal(brani[0].artist, 'Radiohead');
    assert.ok(brani[0].file.endsWith('0.flac'));
    assert.ok(!('file' in JSON.parse(JSON.stringify(brani[0]))));
  });

  it('"folk rock" trova Folk-Rock ma non il generico Rock', () => {
    assert.equal(fuzzyIncludes('folk rock', 'Folk-Rock'), true);
    assert.equal(fuzzyIncludes('folk rock', 'Rock'), false);
  });
});

describe('plan', () => {
  it('rifiuta una richiesta vuota senza disturbare il modello', async () => {
    const web = modello();
    assert.equal((await piano(web, '   ')).ok, false);
    assert.equal(web.ricevuti.length, 0);
  });

  it('riporta il motivo se il modello non risponde', async () => {
    const r = await piano(modello({ ok: false, reason: 'LM Studio spento' }), 'jazz');
    assert.deepEqual([r.ok, r.error], [false, 'LM Studio spento']);
  });

  it('filtra per artista e usa i numeri scelti dal modello', async () => {
    const web = modello(ok({ artists: ['beatles'], count: 3 }), ok({ chosen: [2, 2, 1, 99, 3], name: 'Fab' }));
    const r = await piano(web, 'tre pezzi dei Beatles');
    assert.equal(r.ok, true);
    assert.equal(r.name, 'Fab');
    assert.equal(r.tracks.length, 3);
    assert.ok(r.tracks.every((t) => t.artist === 'The Beatles'));
    assert.equal(new Set(r.tracks.map((t) => t.albumId + t.index)).size, 3);
    assert.deepEqual(r.criteria.matchedArtists, ['The Beatles']);
  });

  it('applica le esclusioni lato server', async () => {
    const r = await piano(modello(ok({ genres: ['rock'], excludeArtists: ['Beatles'] })), 'rock ma niente Beatles');
    assert.equal(r.ok, true);
    assert.ok(r.tracks.length > 0);
    assert.ok(r.tracks.every((t) => t.artist !== 'The Beatles'));
  });

  it('avvisa per gli artisti che non sono in libreria', async () => {
    const r = await piano(modello(ok({ artists: ['Beatles', 'Mozart'], count: 2 }), ok({ chosen: [1, 2] })), 'x');
    assert.ok(r.warnings.some((w) => w.includes('"Mozart"')));
  });

  it('se la scelta finale fallisce ripiega su una selezione automatica', async () => {
    const r = await piano(modello(ok({ count: 4 }), { ok: false, reason: 'timeout' }), 'quattro brani');
    assert.equal(r.ok, true);
    assert.equal(r.tracks.length, 4);
    assert.ok(r.warnings.some((w) => w.includes('ripiego')));
    // il ripiego pesca a rotazione dagli album: quattro album diversi
    assert.equal(new Set(r.tracks.map((t) => t.albumId)).size, 4);
  });

  it('un brano per album', async () => {
    const web = modello(ok({ onePerAlbum: true, count: 4 }), ok({ chosen: [1, 2, 3, 4] }));
    const r = await piano(web, 'un brano per album');
    assert.equal(r.tracks.length, 4);
    assert.equal(new Set(r.tracks.map((t) => t.albumId)).size, 4);
  });

  it('una durata complessiva decide quanti brani servono', async () => {
    const r = await piano(modello(ok({ artists: ['Beatles'], totalMinutes: 15 })), 'un quarto d\'ora di Beatles');
    const totale = r.tracks.reduce((s, t) => s + t.duration, 0);
    assert.ok(totale >= 15 * 60, String(totale));
    assert.ok(totale - r.tracks[r.tracks.length - 1].duration < 15 * 60, 'l\'ultimo brano serve davvero');
  });

  it('durata minima e ordine cronologico', async () => {
    const r = await piano(modello(ok({ minSeconds: 250, chronological: true, count: 60 })), 'brani lunghi in ordine');
    assert.ok(r.tracks.every((t) => t.duration >= 250));
    const anni = r.tracks.map((t) => t.year);
    assert.deepEqual(anni, anni.slice().sort((a, b) => a - b));
  });

  it('"simile a X" usa i generi di X ed esclude X', async () => {
    const r = await piano(modello(ok({ similarTo: 'Radiohead', count: 60 })), 'simile ai Radiohead');
    assert.deepEqual(r.criteria.matchedGenres, ['Alternative Rock']);
    assert.equal(r.ok, false, 'in libreria non c\'e\' altro Alternative Rock');
  });

  it('nessun brano corrispondente', async () => {
    const r = await piano(modello(ok({ genres: ['Jazz'], yearMin: 2000 })), 'jazz recente');
    assert.equal(r.ok, false);
    assert.match(r.error, /Nessun brano/);
  });

  it('l\'atmosfera senza analisi audio viene solo segnalata', async () => {
    const r = await piano(modello(ok({ genres: ['Folk'], audio: { arousal: 'low' } })), 'folk tranquillo');
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.includes('Analisi audio non disponibile')));
  });
});
