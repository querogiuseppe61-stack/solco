'use strict';

const path = require('path');
const { normalize } = require('./web-info');

// Tenuto prudente: molti modelli locali girano con un contesto di appena 4096 token
// (limite tipico di default in LM Studio), e un elenco piu' lungo di candidati
// rischia di superarlo, facendo fallire la scelta finale.
// Con un modello locale l'elenco dei candidati deve stare in 4096 token (limite
// tipico di LM Studio); con OpenRouter il contesto e' ampio e tenere 100 candidati
// significava buttare via meta' libreria prima ancora di scegliere.
const CANDIDATE_CAP_LOCALE = 100;
const CANDIDATE_CAP_REMOTO = 300;
const MAX_PER_ARTIST_WHEN_CAPPING = 4;
const DEFAULT_COUNT = 15;
const MIN_COUNT = 1;
const MAX_COUNT = 60;

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return '?:??';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function flattenTracks(albums) {
  const out = [];
  for (const album of albums) {
    for (const t of album.tracks) {
      out.push({
        albumId: album.id,
        index: t.i,
        title: t.title,
        artist: t.artist || album.artist,
        albumArtist: album.artist,
        album: album.title,
        year: album.year,
        genre: album.genre || [],
        duration: Number.isFinite(t.duration) ? t.duration : null,
        cover: album.cover
      });
      // percorso del file: serve per ritrovare le caratteristiche audio in cache.
      // Non enumerabile, cosi' non finisce nel JSON mandato al client.
      Object.defineProperty(out[out.length - 1], 'file', {
        value: album.dir ? path.join(album.dir, t.file) : null,
        enumerable: false
      });
    }
  }
  return out;
}

// Confronto tollerante: normalizza entrambe le stringhe e verifica se una
// contiene l'altra. Va bene per nomi propri: "leon" trova "Kings of Leon",
// ma non confonde "Adams" con "Adam" (nessuna delle due e' sottostringa dell'altra).
function fuzzyContains(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Corrispondenza per i generi. A differenza di fuzzyContains e' a senso unico:
// il TAG reale deve contenere la richiesta (es. tag "Progressive Rock; Rock"
// contiene la richiesta "progressive rock"), mai il contrario - altrimenti un
// tag corto e generico come "Rock" combacerebbe con qualunque richiesta piu'
// specifica che contenga quella parola, tipo "prog rock" (che letteralmente
// contiene "rock" come sottostringa). Come ripiego per le abbreviazioni
// ("prog" -> "progressive") richiede che OGNI parola della richiesta trovi
// una parola del tag di cui e' prefisso o che ne e' prefisso.
function fuzzyIncludes(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb || nb.includes(na)) return true;
  const tokensA = na.split(' ').filter((t) => t.length >= 3);
  const tokensB = nb.split(' ').filter((t) => t.length >= 3);
  if (!tokensA.length || !tokensB.length) return false;
  return tokensA.every((ta) => tokensB.some((tb) => ta.startsWith(tb) || tb.startsWith(ta)));
}

function matchOne(rawName, realValues, compareFn) {
  const candidates = realValues
    .map((real) => ({ real, hit: compareFn(rawName, real) }))
    .filter((c) => c.hit);
  if (!candidates.length) return null;
  // preferisce la corrispondenza normalizzata piu' vicina in lunghezza (meno "annacquata")
  candidates.sort((x, y) => Math.abs(x.real.length - rawName.length) - Math.abs(y.real.length - rawName.length));
  return candidates[0].real;
}

function matchList(rawNames, realValues, compareFn) {
  const matched = [];
  const unmatched = [];
  for (const raw of rawNames || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const hit = matchOne(name, realValues, compareFn);
    if (hit && !matched.includes(hit)) matched.push(hit);
    else if (!hit) unmatched.push(name);
  }
  return { matched, unmatched };
}

// Come matchList, ma per ogni nome raccoglie TUTTE le varianti reali corrispondenti
// (non solo la piu' vicina): i generi nei tag sono scritti in modo incoerente
// ("Neo-Prog" / "Neo-prog" / "prog-rock"...) e vanno filtrati tutti insieme,
// altrimenti restano fuori brani che semanticamente sono dello stesso genere.
function matchAllVariants(rawNames, realValues, compareFn) {
  const matched = new Set();
  const unmatched = [];
  for (const raw of rawNames || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const hits = realValues.filter((real) => compareFn(name, real));
    if (hits.length) hits.forEach((h) => matched.add(h));
    else unmatched.push(name);
  }
  return { matched: [...matched], unmatched };
}

function clampCount(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, n));
}

function interpretPrompt(prompt) {
  return [
    'Sei un assistente che interpreta richieste di creazione di playlist musicali,',
    'scritte in italiano o inglese da un utente per la propria libreria personale.',
    'Restituisci SOLO un oggetto JSON con questa forma esatta, senza altro testo prima o dopo:',
    '{',
    '  "count": <numero intero di brani richiesti, tra 1 e 60; se non specificato usa 15>,',
    '  "artists": [<nomi di artisti o gruppi menzionati, stringhe; vuoto se nessuno>],',
    '  "genres": [<generi musicali menzionati, stringhe; vuoto se nessuno>],',
    '  "excludeArtists": [<artisti da ESCLUDERE esplicitamente ("senza X", "niente X", "ma non X")>],',
    '  "excludeGenres": [<generi da ESCLUDERE esplicitamente>],',
    '  "similarTo": <se si chiede "qualcosa di simile a X" o "sullo stile di X", il nome di X; altrimenti stringa vuota>,',
    '  "titleContains": <parola che deve comparire nel TITOLO dei brani, se richiesto; altrimenti stringa vuota>,',
    '  "maxPerArtist": <numero massimo di brani PER ARTISTA, solo se chiesto esplicitamente',
    '                    ("al massimo uno per artista" -> 1, "cinque a testa" -> 5); altrimenti null.',
    '                    "un brano per ogni album" NON e\' un limite per artista: lascia null>,',
    '  "onePerAlbum": <true se si chiede un solo brano per album o disco, altrimenti false>,',
    '  "totalMinutes": <durata totale in minuti se richiesta ("un\'ora" -> 60, "mezz\'ora" -> 30); altrimenti null>,',
    '  "minSeconds": <durata minima del singolo brano in secondi ("oltre gli 8 minuti" -> 480); altrimenti null>,',
    '  "maxSeconds": <durata massima del singolo brano in secondi; altrimenti null>,',
    '  "chronological": <true SOLO se si chiede esplicitamente un ORDINE ("in ordine cronologico",',
    '                     "dal piu\' vecchio al piu\' recente"). "brani degli anni 90" o "dal 2015"',
    '                     indicano un periodo, non un ordine: in quei casi lascia false>,',
    '  "yearMin": <anno minimo se e\' menzionato un periodo, altrimenti null>,',
    '  "yearMax": <anno massimo se e\' menzionato un periodo, altrimenti null>,',
    '  "durationBias": <"long" se si chiedono brani lunghi, "short" se brevi, altrimenti "none">,',
    '  "selectionStyle": <"well_known" per i brani piu\' noti/famosi, "deep_cuts" per quelli meno noti,',
    '                     "vibe" se la richiesta descrive un\'atmosfera o una sensazione, "diverse" per varieta\' generale,',
    '                     oppure "random" se non ci sono preferenze>,',
    '  "vibe": <descrizione libera in italiano di atmosfere o sensazioni menzionate, stringa vuota se non applicabile>,',
    '  "audio": {',
    '    "valence": <"low" se la richiesta suggerisce musica triste, cupa, malinconica; "high" se allegra, solare, positiva; altrimenti null>,',
    '    "arousal": <"low" se suggerisce musica calma, quieta, rilassata, notturna; "high" se energica, intensa, movimentata; altrimenti null>,',
    '    "instrumentalOnly": <true solo se si chiedono esplicitamente brani strumentali o senza voce, altrimenti false>,',
    '    "preferisci": [<sottoinsieme di ["sad","relaxed","happy","aggressive","party","acoustic","electronic","danceable"] da massimizzare>],',
    '    "evita": [<sottoinsieme degli stessi valori da minimizzare>]',
    '  }',
    '}',
    'Il campo "audio" traduce l\'atmosfera richiesta in caratteristiche misurate sul suono reale dei brani.',
    'Esempi: "notturno" -> arousal "low", preferisci ["relaxed"], evita ["party","aggressive"].',
    '"malinconico" -> valence "low", preferisci ["sad"]. "solo strumentali" -> instrumentalOnly true.',
    'Se la richiesta non parla di atmosfera, lascia valence e arousal a null e gli elenchi vuoti.',
    'ATTENZIONE: le parole che descrivono come SUONA la musica (acustico, rilassato, energico,',
    'ballabile, aggressivo, malinconico, allegro) NON sono generi: vanno in "audio", mai in',
    '"genres". In "genres" metti solo nomi di generi veri (rock, folk, jazz, progressive rock).',
    'Se la richiesta chiede una durata complessiva, compila "totalMinutes" e lascia "count" al',
    'valore predefinito: al numero di brani ci pensa chi riceve questo JSON.',
    'Non aggiungere spiegazioni, commenti, ne\' testo fuori dal JSON.'
  ].join('\n');
}

const MOOD_VALIDI = ['sad', 'relaxed', 'happy', 'aggressive', 'party', 'acoustic', 'electronic', 'danceable'];

function normalizzaAudio(raw) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  const dir = (v) => (v === 'low' || v === 'high' ? v : null);
  const lista = (v) => (Array.isArray(v) ? v.filter((x) => MOOD_VALIDI.includes(x)) : []);
  const audio = {
    valence: dir(a.valence),
    arousal: dir(a.arousal),
    instrumentalOnly: a.instrumentalOnly === true,
    preferisci: lista(a.preferisci),
    evita: lista(a.evita)
  };
  audio.attivo = !!(audio.valence || audio.arousal || audio.instrumentalOnly || audio.preferisci.length || audio.evita.length);
  return audio;
}

// Punteggio 0..1-ish: quanto un brano corrisponde all'atmosfera richiesta.
// valence e arousal stanno su scala 1-9, i mood su 0-1.
function punteggioAudio(f, audio) {
  let p = 0;
  if (audio.valence === 'low') p += (9 - f.valence) / 8;
  else if (audio.valence === 'high') p += (f.valence - 1) / 8;
  if (audio.arousal === 'low') p += (9 - f.arousal) / 8;
  else if (audio.arousal === 'high') p += (f.arousal - 1) / 8;
  for (const m of audio.preferisci) if (Number.isFinite(f[m])) p += f[m];
  for (const m of audio.evita) if (Number.isFinite(f[m])) p -= f[m];
  return p;
}

function selectionPrompt(criteria, audioUsata) {
  const count = criteria.count;
  const extra = [];
  if (audioUsata) {
    // Senza questa riga il modello scriveva "mi sono basato sui titoli" anche
    // quando i candidati erano gia' ordinati dall'analisi del suono reale.
    extra.push('- I candidati sono GIA\' stati filtrati e ordinati in base all\'analisi del suono');
    extra.push('  reale dei brani: i primi dell\'elenco sono i piu\' aderenti all\'atmosfera chiesta.');
    extra.push('  Non dire che ti sei basato sui titoli: l\'atmosfera e\' gia\' verificata sull\'audio.');
  }
  if (criteria.maxPerArtist) extra.push('- Non usare lo stesso artista piu\' di ' + criteria.maxPerArtist + ' volte.');
  if (criteria.onePerAlbum) extra.push('- Un solo brano per album.');
  if (criteria.chronological) extra.push('- L\'ordine finale sara\' cronologico: pensa alla scelta, non alla sequenza.');
  if (criteria.totalMinutes) extra.push('- La playlist deve durare circa ' + criteria.totalMinutes + ' minuti in tutto.');
  if (criteria.titleContains) extra.push('- Tutti i candidati hanno gia\' "' + criteria.titleContains + '" nel titolo: non e\' un criterio di scelta.');
  if (criteria.excludedArtists.length) extra.push('- Gli artisti esclusi sono gia\' stati tolti dall\'elenco.');
  return [
    'Sei un curatore musicale che sceglie brani SOLO da un elenco chiuso e reale,',
    'tratto dalla libreria musicale dell\'utente. Non conosci altri brani oltre a quelli elencati.',
    'Regole:',
    '- Scegli ESATTAMENTE ' + count + ' brani dall\'elenco numerato fornito, usando solo gli indici presenti.'
  ].concat(extra).concat([
    '- Non inventare mai brani, indici o titoli che non compaiono nell\'elenco.',
    '- Se ti viene chiesto di scegliere i brani piu\' noti o famosi, usa la tua conoscenza generale',
    '  dell\'artista, ma se non hai informazioni sufficienti scegli comunque in modo ragionevole',
    '  (es. tracce singole, album piu\' celebri) e segnalalo nel campo "note".',
    '- Se la richiesta descrive un\'atmosfera (es. "notturno", "malinconico") e non hai modo di conoscere',
    '  il suono reale dei brani, fai una stima ragionevole basata su titoli, artisti e generi disponibili,',
    '  e segnala chiaramente questo limite nel campo "note".',
    '- Cerca una certa varieta\' di artisti quando la richiesta non ne specifica uno preciso.',
    'Rispondi SOLO con un oggetto JSON in questa forma, senza altro testo:',
    '{ "chosen": [<indici scelti, numeri interi>], "name": "<nome breve e accattivante per la playlist, in italiano>",',
    '  "note": "<una o due frasi in italiano che spiegano la scelta ed eventuali limiti>" }'
  ]).join('\n');
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function chiaveArtista(t) {
  return (t.albumArtist || t.artist || '').toLowerCase();
}

// Mette davanti al massimo N brani per artista, senza perdere l'ordine di
// partenza: serve sia quando l'ordine e' casuale sia quando e' per aderenza
// all'atmosfera, dove prima il tetto non veniva applicato affatto e una playlist
// "notturna" poteva uscire tutta dello stesso disco.
function prioritizzaArtisti(pool, tetto) {
  const perArtista = new Map();
  const primi = [];
  const resto = [];
  for (const t of pool) {
    const k = chiaveArtista(t);
    const n = perArtista.get(k) || 0;
    if (n < tetto) {
      perArtista.set(k, n + 1);
      primi.push(t);
    } else {
      resto.push(t);
    }
  }
  return primi.concat(resto);
}

function capCandidates(pool, criteria, giaOrdinato, tetto) {
  if (pool.length <= tetto) {
    // Anche senza taglio l'ordine conta: l'elenco arriva qui alfabetico per
    // artista e un modello che legge dall'alto tende a pescare dalle prime lettere.
    const senzaOrdine = !giaOrdinato && criteria.durationBias === 'none';
    return { pool: senzaOrdine ? shuffle(pool) : pool, capped: false };
  }
  const perArtista = criteria.maxPerArtist || MAX_PER_ARTIST_WHEN_CAPPING;
  if (giaOrdinato) {
    // l'ordine per aderenza all'atmosfera e' l'informazione piu' preziosa che
    // abbiamo e va conservato, ma il tetto per artista si applica lo stesso
    return { pool: prioritizzaArtisti(pool, perArtista).slice(0, tetto), capped: true };
  }
  let ordered;
  if (criteria.durationBias === 'long') {
    ordered = pool.slice().sort((a, b) => (b.duration || 0) - (a.duration || 0));
  } else if (criteria.durationBias === 'short') {
    ordered = pool.slice().sort((a, b) => (a.duration == null ? Infinity : a.duration) - (b.duration == null ? Infinity : b.duration));
  } else {
    // Senza un ordine sensato il bacino arriva qui in ordine alfabetico di
    // artista, e tagliare i primi 100 significava vedere sempre e solo la A.
    ordered = prioritizzaArtisti(shuffle(pool), perArtista);
  }
  return { pool: ordered.slice(0, tetto), capped: true };
}

// "love" trova Love, Lovecats e Lovesong, non Glover: la parola deve iniziare
// una parola del titolo. Con piu' parole si torna al contenimento semplice.
function titoloContiene(titolo, cercata) {
  const nt = normalize(titolo);
  const nc = normalize(cercata);
  if (!nt || !nc) return false;
  if (nc.includes(' ')) return nt.includes(nc);
  return nt.split(' ').some((p) => p.startsWith(nc));
}

// Pesca a rotazione tra gli album distinti presenti nell'elenco, cosi' un ripiego
// senza IA non finisce per prendere N tracce dello stesso disco.
function diverseSample(list, n) {
  const byAlbum = new Map();
  for (const t of list) {
    const key = t.albumId + '|' + t.album;
    if (!byAlbum.has(key)) byAlbum.set(key, []);
    byAlbum.get(key).push(t);
  }
  const groups = [...byAlbum.values()];
  const out = [];
  let i = 0;
  while (out.length < n && groups.some((g) => g.length)) {
    const g = groups[i % groups.length];
    if (g.length) out.push(g.shift());
    i++;
  }
  return out;
}

function createAiPlaylistService(deps) {
  const webInfo = deps.webInfo;
  const audioFeatures = deps.audioFeatures || null;

  // Applica i criteri di atmosfera basati sull'analisi del suono reale.
  // Restituisce anche quanti brani sono rimasti fuori perche' non ancora analizzati,
  // cosi' l'utente sa se il risultato e' parziale invece di riceverlo in silenzio.
  function applicaAudio(pool, audio) {
    if (!audio.attivo || !audioFeatures) return { pool, usata: false, senzaAnalisi: 0 };

    const conFeature = [];
    let senzaAnalisi = 0;
    for (const t of pool) {
      const f = t.file ? audioFeatures.featuresDi(t.file) : null;
      if (!f) { senzaAnalisi++; continue; }
      if (audio.instrumentalOnly && !(f.instrumental >= 0.6)) continue;
      conFeature.push({ t, punteggio: punteggioAudio(f, audio) });
    }
    if (!conFeature.length) return { pool: [], usata: true, senzaAnalisi };
    conFeature.sort((a, b) => b.punteggio - a.punteggio);
    return { pool: conFeature.map((x) => x.t), usata: true, senzaAnalisi, ordinato: true };
  }

  function filterCandidates(allTracks, criteria) {
    let pool = allTracks;
    if (criteria.matchedArtists.length) {
      const wanted = new Set(criteria.matchedArtists.map((a) => a.toLowerCase()));
      pool = pool.filter((t) => wanted.has((t.albumArtist || '').toLowerCase()) || wanted.has((t.artist || '').toLowerCase()));
    }
    if (criteria.matchedGenres.length) {
      const wanted = new Set(criteria.matchedGenres.map((g) => g.toLowerCase()));
      pool = pool.filter((t) => (t.genre || []).some((g) => wanted.has(g.toLowerCase())));
    }
    // Le esclusioni le applica il server: prima sopravvivevano solo se il modello
    // del secondo passaggio si ricordava di rileggerle nella richiesta originale.
    if (criteria.excludedArtists.length) {
      const fuori = new Set(criteria.excludedArtists.map((a) => a.toLowerCase()));
      pool = pool.filter((t) => !fuori.has((t.albumArtist || '').toLowerCase()) && !fuori.has((t.artist || '').toLowerCase()));
    }
    if (criteria.excludedGenres.length) {
      const fuori = new Set(criteria.excludedGenres.map((g) => g.toLowerCase()));
      pool = pool.filter((t) => !(t.genre || []).some((g) => fuori.has(g.toLowerCase())));
    }
    if (criteria.titleContains) {
      pool = pool.filter((t) => titoloContiene(t.title, criteria.titleContains));
    }
    if (criteria.minSeconds != null) pool = pool.filter((t) => Number.isFinite(t.duration) && t.duration >= criteria.minSeconds);
    if (criteria.maxSeconds != null) pool = pool.filter((t) => Number.isFinite(t.duration) && t.duration <= criteria.maxSeconds);
    if (criteria.yearMin != null) pool = pool.filter((t) => t.year != null && t.year >= criteria.yearMin);
    if (criteria.yearMax != null) pool = pool.filter((t) => t.year != null && t.year <= criteria.yearMax);
    return pool;
  }

  // Applica i vincoli che il modello non puo' garantire: quota per artista, un
  // brano per album, durata complessiva, ordine cronologico. Quando un vincolo
  // toglie brani si ripesca dai candidati rimasti.
  function applicaVincoli(scelti, candidati, criteria) {
    let out = scelti.slice();
    const note = [];

    const tetti = [];
    if (criteria.onePerAlbum) tetti.push({ chiave: (t) => t.albumId, max: 1, nome: 'album' });
    if (criteria.maxPerArtist) tetti.push({ chiave: chiaveArtista, max: criteria.maxPerArtist, nome: 'artista' });

    for (const tetto of tetti) {
      const conteggi = new Map();
      const tenuti = [];
      let tolti = 0;
      for (const t of out) {
        const k = tetto.chiave(t);
        const n = conteggi.get(k) || 0;
        if (n >= tetto.max) { tolti++; continue; }
        conteggi.set(k, n + 1);
        tenuti.push(t);
      }
      if (!tolti) { out = tenuti; continue; }
      const usati = new Set(tenuti.map((t) => t.albumId + '|' + t.index));
      for (const t of candidati) {
        if (tenuti.length >= out.length) break;
        if (usati.has(t.albumId + '|' + t.index)) continue;
        const k = tetto.chiave(t);
        if ((conteggi.get(k) || 0) >= tetto.max) continue;
        conteggi.set(k, (conteggi.get(k) || 0) + 1);
        usati.add(t.albumId + '|' + t.index);
        tenuti.push(t);
      }
      if (tenuti.length < out.length) {
        note.push('Con il limite di ' + tetto.max + ' brani per ' + tetto.nome +
          ' la libreria ne offre ' + tenuti.length + ' invece dei ' + out.length + ' previsti.');
      }
      out = tenuti;
    }

    if (criteria.totalMinutes) {
      const obiettivo = criteria.totalMinutes * 60;
      const durata = (l) => l.reduce((s, t) => s + (t.duration || 240), 0);
      while (out.length > 1 && durata(out) - (out[out.length - 1].duration || 240) >= obiettivo) out.pop();
      if (durata(out) < obiettivo) {
        const usati = new Set(out.map((t) => t.albumId + '|' + t.index));
        const conteggi = new Map();
        for (const t of out) conteggi.set(chiaveArtista(t), (conteggi.get(chiaveArtista(t)) || 0) + 1);
        const perAlbum = new Map();
        for (const t of out) perAlbum.set(t.albumId, (perAlbum.get(t.albumId) || 0) + 1);
        for (const t of candidati) {
          if (durata(out) >= obiettivo) break;
          if (usati.has(t.albumId + '|' + t.index)) continue;
          if (criteria.maxPerArtist && (conteggi.get(chiaveArtista(t)) || 0) >= criteria.maxPerArtist) continue;
          if (criteria.onePerAlbum && (perAlbum.get(t.albumId) || 0) >= 1) continue;
          conteggi.set(chiaveArtista(t), (conteggi.get(chiaveArtista(t)) || 0) + 1);
          perAlbum.set(t.albumId, (perAlbum.get(t.albumId) || 0) + 1);
          usati.add(t.albumId + '|' + t.index);
          out.push(t);
        }
      }
      const minuti = Math.round(durata(out) / 60);
      note.push('Durata complessiva: ' + minuti + ' minuti sui ' + criteria.totalMinutes + ' richiesti.');
    }

    if (criteria.chronological) {
      out.sort((a, b) => (a.year || 9999) - (b.year || 9999) ||
        String(a.album).localeCompare(String(b.album)) || (a.index || 0) - (b.index || 0));
    }
    return { tracks: out, note };
  }

  async function plan(albums, promptRaw) {
    const prompt = String(promptRaw || '').trim();
    if (!prompt) return { ok: false, error: 'Descrivi la playlist che vuoi ottenere.' };

    const allTracks = flattenTracks(albums);
    if (!allTracks.length) return { ok: false, error: 'La libreria non contiene ancora brani da poter scegliere.' };

    const step1 = await webInfo.chatJSON(interpretPrompt(), prompt, { temperature: 0.2, maxTokens: 400 });
    if (!step1.ok) return { ok: false, error: step1.reason || 'Il modello locale non e\' disponibile.' };

    const raw = step1.data || {};
    const count = clampCount(raw.count);
    const realArtists = [...new Set(allTracks.map((t) => t.albumArtist).filter(Boolean))];
    const realGenres = [...new Set(allTracks.flatMap((t) => t.genre).filter(Boolean))];
    const artistMatch = matchList(Array.isArray(raw.artists) ? raw.artists : [], realArtists, fuzzyContains);
    const genreMatch = matchAllVariants(Array.isArray(raw.genres) ? raw.genres : [], realGenres, fuzzyIncludes);

    const escludiArtisti = matchList(Array.isArray(raw.excludeArtists) ? raw.excludeArtists : [], realArtists, fuzzyContains);
    const escludiGeneri = matchAllVariants(Array.isArray(raw.excludeGenres) ? raw.excludeGenres : [], realGenres, fuzzyIncludes);
    const intero = (v, min, max) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= min && n <= max ? n : null;
    };

    const criteria = {
      count,
      matchedArtists: artistMatch.matched,
      matchedGenres: genreMatch.matched,
      excludedArtists: escludiArtisti.matched,
      excludedGenres: escludiGeneri.matched,
      similarTo: '',
      titleContains: String(raw.titleContains || '').trim().slice(0, 60),
      maxPerArtist: intero(raw.maxPerArtist, 1, 20),
      onePerAlbum: raw.onePerAlbum === true,
      totalMinutes: intero(raw.totalMinutes, 5, 300),
      minSeconds: intero(raw.minSeconds, 1, 7200),
      maxSeconds: intero(raw.maxSeconds, 1, 7200),
      chronological: raw.chronological === true,
      yearMin: Number.isFinite(raw.yearMin) ? raw.yearMin : null,
      yearMax: Number.isFinite(raw.yearMax) ? raw.yearMax : null,
      durationBias: ['long', 'short'].includes(raw.durationBias) ? raw.durationBias : 'none',
      selectionStyle: ['well_known', 'deep_cuts', 'vibe', 'diverse', 'random'].includes(raw.selectionStyle) ? raw.selectionStyle : 'diverse',
      vibe: String(raw.vibe || '').trim(),
      audio: normalizzaAudio(raw.audio)
    };

    const warnings = [];
    for (const name of artistMatch.unmatched) warnings.push('Nessun artista simile a "' + name + '" trovato nella tua libreria.');
    for (const name of genreMatch.unmatched) warnings.push('Nessun genere simile a "' + name + '" trovato nella tua libreria.');
    for (const name of escludiArtisti.unmatched) warnings.push('Nessun artista simile a "' + name + '" da escludere: non era in libreria.');

    // "un brano per ogni album di X" e' una richiesta su un solo artista: un tetto
    // per artista la ridurrebbe a un brano solo. Se arrivano insieme vince l'album.
    if (criteria.onePerAlbum && criteria.maxPerArtist && criteria.matchedArtists.length === 1) {
      criteria.maxPerArtist = null;
    }

    // "simile a X": si prendono i generi di X e si esclude X stesso. Senza questo
    // la richiesta non produceva alcun criterio e restava una pescata alfabetica.
    const simile = String(raw.similarTo || '').trim();
    if (simile) {
      const trovato = matchOne(simile, realArtists, fuzzyContains);
      if (!trovato) {
        warnings.push('Nessun artista simile a "' + simile + '" in libreria: non ho potuto usarlo come riferimento.');
      } else {
        criteria.similarTo = trovato;
        if (!criteria.excludedArtists.some((a) => a.toLowerCase() === trovato.toLowerCase())) {
          criteria.excludedArtists.push(trovato);
        }
        if (!criteria.matchedGenres.length) {
          const suoi = [...new Set(allTracks
            .filter((t) => (t.albumArtist || '').toLowerCase() === trovato.toLowerCase())
            .flatMap((t) => t.genre || [])
            .filter(Boolean))];
          if (suoi.length) {
            criteria.matchedGenres = suoi;
            warnings.push('"Simile a ' + trovato + '": cercati brani dei suoi generi (' +
              suoi.slice(0, 4).join(', ') + (suoi.length > 4 ? '…' : '') + '), escluso ' + trovato + '.');
          } else {
            warnings.push('"' + trovato + '" non ha generi nei tag: ho potuto solo escluderlo dai risultati.');
          }
        }
      }
    }

    let pool = filterCandidates(allTracks, criteria);
    if (!pool.length) {
      return {
        ok: false,
        error: 'Nessun brano corrisponde a questi criteri nella tua libreria.',
        criteria,
        warnings
      };
    }

    // Con una durata complessiva richiesta il numero di brani non lo decide il
    // modello ma la durata media di quelli disponibili: "un'ora" non e' quindici
    // brani, sono tanti quanti ne stanno in un'ora.
    if (criteria.totalMinutes) {
      const durate = pool.map((t) => t.duration).filter(Number.isFinite);
      const media = durate.length ? durate.reduce((a, b) => a + b, 0) / durate.length : 240;
      criteria.count = Math.min(MAX_COUNT, Math.max(MIN_COUNT,
        Math.ceil((criteria.totalMinutes * 60) / media) + 2));
    }

    // Criteri di atmosfera: si appoggiano all'analisi del suono, quando disponibile
    const esitoAudio = applicaAudio(pool, criteria.audio);
    if (esitoAudio.usata) {
      if (!esitoAudio.pool.length) {
        return {
          ok: false,
          error: esitoAudio.senzaAnalisi
            ? 'Per le richieste basate sull\'atmosfera serve prima l\'analisi audio della libreria: nessuno dei brani corrispondenti è ancora stato analizzato.'
            : 'Nessun brano corrisponde a questa atmosfera tra quelli analizzati.',
          criteria,
          warnings
        };
      }
      if (esitoAudio.senzaAnalisi) {
        warnings.push('Atmosfera valutata sui ' + esitoAudio.pool.length + ' brani già analizzati; ' + esitoAudio.senzaAnalisi + ' non ancora analizzati sono rimasti fuori.');
      } else {
        warnings.push('Atmosfera valutata sull\'analisi del suono reale di ' + esitoAudio.pool.length + ' brani.');
      }
      pool = esitoAudio.pool;
    } else if (criteria.audio.attivo && !audioFeatures) {
      warnings.push('Analisi audio non disponibile: l\'atmosfera è stata interpretata solo da titoli, artisti e generi.');
    }

    // Con un provider remoto il contesto e' ampio: tenere 100 candidati era una
    // cautela tarata sui modelli locali da 4k.
    let tetto = CANDIDATE_CAP_LOCALE;
    try {
      const stato = await webInfo.aiStatus();
      if (stato && /openrouter/i.test(stato.provider || '')) tetto = CANDIDATE_CAP_REMOTO;
    } catch (e) {}

    const { pool: candidates, capped } = capCandidates(pool, criteria, esitoAudio.ordinato, tetto);
    if (capped) {
      warnings.push('Trovati ' + pool.length + ' brani corrispondenti: ne ho considerati ' + candidates.length +
        (esitoAudio.ordinato
          ? ', i più aderenti all\'atmosfera.'
          : criteria.durationBias === 'none'
            ? ', presi a caso fra tutti.'
            : ', i più adatti per durata.'));
    }

    // se i candidati sono gia' pochi quanto (o meno di) il richiesto, non serve interpellare
    // di nuovo il modello: si restituiscono cosi' come sono.
    if (candidates.length <= criteria.count) {
      if (candidates.length < criteria.count) {
        warnings.push('Trovati solo ' + candidates.length + ' brani corrispondenti, meno dei ' + criteria.count + ' richiesti.');
      }
      const vincolati = applicaVincoli(candidates, candidates, criteria);
      warnings.push(...vincolati.note);
      return {
        ok: true,
        tracks: vincolati.tracks,
        name: suggestNameFallback(criteria),
        note: 'Selezionati tutti i brani della tua libreria che corrispondono ai criteri richiesti.',
        criteria,
        warnings
      };
    }

    const listText = candidates
      .map((t, i) => (i + 1) + ') ' + t.artist + ' - ' + t.title + ' (' + t.album + (t.year ? ', ' + t.year : '') + ') - ' + fmtDuration(t.duration))
      .join('\n');
    const userPrompt = [
      'Richiesta originale dell\'utente: ' + prompt,
      'Brani candidati disponibili (usa solo questi numeri):',
      listText
    ].join('\n\n');

    const step2 = await webInfo.chatJSON(selectionPrompt(criteria, !!esitoAudio.ordinato), userPrompt, {
      temperature: 0.4,
      maxTokens: 200 + criteria.count * 6,
      // un modello locale puo' metterci un po' con un elenco di candidati lungo:
      // stesso margine gia' usato per le schede album/artista.
      timeoutMs: 180000
    });

    if (!step2.ok) {
      // ripiego deterministico, cosi' la funzione non fallisce del tutto: pesca a rotazione
      // dai vari album invece di prendere le prime tracce in ordine alfabetico.
      warnings.push('Il modello non ha risposto per la scelta finale (' + (step2.reason || 'errore sconosciuto') + '): uso una selezione automatica come ripiego.');
      const ripiego = applicaVincoli(diverseSample(candidates, criteria.count), candidates, criteria);
      warnings.push(...ripiego.note);
      return {
        ok: true,
        tracks: ripiego.tracks,
        name: suggestNameFallback(criteria),
        note: '',
        criteria,
        warnings
      };
    }

    const chosenIdx = Array.isArray(step2.data.chosen) ? step2.data.chosen : [];
    const seen = new Set();
    let chosenTracks = [];
    for (const idx of chosenIdx) {
      const i = Number(idx) - 1;
      if (Number.isInteger(i) && i >= 0 && i < candidates.length && !seen.has(i)) {
        seen.add(i);
        chosenTracks.push(candidates[i]);
      }
    }
    if (chosenTracks.length > criteria.count) chosenTracks = chosenTracks.slice(0, criteria.count);
    if (chosenTracks.length < criteria.count) {
      for (let i = 0; i < candidates.length && chosenTracks.length < criteria.count; i++) {
        if (!seen.has(i)) {
          seen.add(i);
          chosenTracks.push(candidates[i]);
        }
      }
      if (chosenIdx.length) warnings.push('Il modello ha indicato meno brani validi del richiesto: completata la lista con altri candidati.');
    }

    const finale = applicaVincoli(chosenTracks, candidates, criteria);
    warnings.push(...finale.note);

    return {
      ok: true,
      tracks: finale.tracks,
      name: String(step2.data.name || '').trim() || suggestNameFallback(criteria),
      note: String(step2.data.note || '').trim(),
      criteria,
      warnings
    };
  }

  return { plan };
}

function suggestNameFallback(criteria) {
  if (criteria.matchedArtists.length === 1) return criteria.matchedArtists[0];
  if (criteria.matchedGenres.length) return criteria.matchedGenres.join(' / ');
  return 'Playlist generata';
}

module.exports = { createAiPlaylistService, flattenTracks, fuzzyIncludes };
