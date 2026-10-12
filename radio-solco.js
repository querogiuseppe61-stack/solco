'use strict';

const crypto = require('crypto');
const { flattenTracks, fuzzyIncludes } = require('./ai-playlist');
const { normalize } = require('./web-info');

// Una puntata di Radio Solco dura circa 45 minuti. Si accetta una puntata che
// stia nella finestra qui sotto: sotto i 38' sembrerebbe monca, sopra i 52'
// sarebbe un'altra cosa.
const TARGET_SECONDS = 45 * 60;
const MIN_SECONDS = 38 * 60;
const MAX_SECONDS = 52 * 60;

// Il modello (spesso locale, con contesto ridotto) riceve al massimo questo
// numero di brani candidati fra cui costruire la scaletta.
const CANDIDATE_CAP = 80;
const MAX_PER_ARTIST = 3;
const MODES = ['random', 'genre', 'decade', 'years', 'mixed'];

// Un genere con pochi brani non puo' reggere 45 minuti: proporlo al modello
// significa quasi sempre finire nel ripiego "troppo pochi brani".
const MIN_BRANI_PER_GENERE = 15;
// Tag inservibili come taglio di una puntata: residui di rippatura e simili.
const ANNO_MINIMO = 1900;

// Quota dei candidati riservata ai brani che il tema ha davvero agganciato. Il
// resto resta pescata libera: senza respiro il modello sarebbe costretto a
// prendere tutto quello che gli passiamo, anche i riscontri deboli.
const QUOTA_TEMATICA = 0.7;
// Sotto questa soglia il tema non regge la puntata: i pochi riscontri sarebbero
// solo coincidenze (cercando "cricket" saltano fuori "Wrecking Ball" e "The
// Game") e il resto della scaletta sarebbe riempitivo sotto un titolo che promette
// altro. Una puntata sta in piedi con una decina di brani.
const MIN_BRANI_A_TEMA = 8;
// Sopra il minimo ma sotto questa soglia la puntata sta in piedi, pero' meta'
// scaletta e' riempitivo: va detto, invece di lasciar credere che sia tutta a tema.
const TEMA_DEBOLE = 20;
// Parole troppo comuni per distinguere un brano dall'altro.
const PAROLE_VUOTE = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'que', 'con', 'per', 'del', 'della',
  'song', 'songs', 'music', 'track', 'canzone', 'canzoni', 'musica', 'brano', 'brani',
  'tema', 'theme', 'love', 'bella', 'bello'
]);

function parolaChiaveValida(k) {
  const n = normalize(k);
  if (n.length < 3) return false;
  return !n.split(' ').every((p) => PAROLE_VUOTE.has(p));
}

function pulisciParoleChiave(raw) {
  if (!Array.isArray(raw)) return [];
  const viste = new Set();
  for (const k of raw) {
    if (typeof k !== 'string' || !parolaChiaveValida(k)) continue;
    viste.add(normalize(k));
    if (viste.size >= 24) break;
  }
  return [...viste];
}

// Quante parole chiave del tema si riconoscono in un brano, e quali. Il titolo
// pesa il doppio: e' li' che il tema si vede, album e artista sono indizi.
function riscontroTema(track, chiavi) {
  const campo = (v) => ' ' + normalize(v) + ' ';
  const titolo = campo(track.title);
  const contorno = campo(track.album) + campo(track.artist);
  let punti = 0;
  let principale = null;
  for (const k of chiavi) {
    const ago = ' ' + k + ' ';
    const nelTitolo = titolo.includes(ago);
    if (!nelTitolo && !contorno.includes(ago)) continue;
    punti += nelTitolo ? 2 : 1;
    // la parola che decide il gruppo e' la prima trovata nel titolo, se c'e'
    if (!principale || (nelTitolo && principale.debole)) principale = { k, debole: !nelTitolo };
  }
  return punti ? { punti, parola: principale.k } : null;
}

// Tiene al massimo MAX_PER_ARTIST brani per artista rispettando l'ordine dato.
function limitaPerArtista(lista, quanti) {
  const perArtista = new Map();
  const out = [];
  for (const t of lista) {
    if (out.length >= quanti) break;
    const chiave = (t.albumArtist || t.artist || '').toLowerCase();
    const n = perArtista.get(chiave) || 0;
    if (n >= MAX_PER_ARTIST) continue;
    perArtista.set(chiave, n + 1);
    out.push(t);
  }
  return out;
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return '?:??';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Firma della scaletta indipendente dall'ordine: due puntate con gli stessi
// identici brani (comunque disposti) hanno la stessa firma. Serve a non
// riproporre mai "la stessa identica scaletta" gia' memorizzata.
function signatureOf(tracks) {
  const key = tracks
    .map((t) => t.albumId + '|' + t.index)
    .sort()
    .join(',');
  return crypto.createHash('sha1').update(key).digest('hex');
}

function trackKey(t) {
  return t.albumId + '|' + t.index;
}

// Campiona il pool tenendo varieta' di artisti: prima N brani per artista, poi
// il resto. Il pool viene rimescolato prima, cosi' puntate diverse sullo stesso
// tema non partono mai dagli stessi candidati.
function sampleDiverse(pool, cap) {
  const shuffled = shuffle(pool);
  const perArtist = new Map();
  const first = [];
  const rest = [];
  for (const t of shuffled) {
    const key = (t.albumArtist || t.artist || '').toLowerCase();
    const n = perArtist.get(key) || 0;
    if (n < MAX_PER_ARTIST) {
      perArtist.set(key, n + 1);
      first.push(t);
    } else {
      rest.push(t);
    }
  }
  return first.concat(rest).slice(0, cap);
}

// Candidati per una puntata a tema. Con "mixed" il pool non si puo' filtrare per
// genere o anno, quindi il filo conduttore si applica qui: prima i brani che le
// parole chiave agganciano davvero (i piu' pertinenti in testa, a pari punteggio
// in ordine sparso), poi pescata libera per il resto. Se non aggancia nulla si
// torna al comportamento di sempre.
function candidatiPerTema(pool, chiavi, cap) {
  const perParola = new Map();
  const altri = [];
  for (const t of shuffle(pool)) {
    const r = riscontroTema(t, chiavi);
    if (!r) {
      altri.push(t);
      continue;
    }
    if (!perParola.has(r.parola)) perParola.set(r.parola, []);
    perParola.get(r.parola).push({ t, punti: r.punti });
  }
  if (!perParola.size) return { candidates: sampleDiverse(pool, cap), aTema: 0 };

  // A turno una parola per volta, dentro ogni parola i riscontri piu' forti
  // prima. Ordinando solo per punteggio la testa dell'elenco si riempiva di brani
  // che agganciano tutti la stessa parola, e la puntata usciva monotona: otto
  // titoli con dentro "time".
  const gruppi = [...perParola.values()].map((g) => g.sort((a, b) => b.punti - a.punti).map((x) => x.t));
  const alternati = [];
  for (let giro = 0; alternati.length < pool.length; giro++) {
    let aggiunto = false;
    for (const g of gruppi) {
      if (giro >= g.length) continue;
      alternati.push(g[giro]);
      aggiunto = true;
    }
    if (!aggiunto) break;
  }

  const quota = Math.max(1, Math.round(cap * QUOTA_TEMATICA));
  const tematici = limitaPerArtista(alternati, Math.min(quota, alternati.length));
  const presi = new Set(tematici.map(trackKey));
  const riempimento = sampleDiverse(altri.filter((t) => !presi.has(trackKey(t))), cap - tematici.length);
  return { candidates: tematici.concat(riempimento), aTema: tematici.length };
}

// Pesca a rotazione fra gli album distinti: un ripiego senza IA non prende
// cosi' quattro brani di fila dello stesso disco.
function roundRobinByAlbum(list, targetSeconds) {
  const byAlbum = new Map();
  for (const t of list) {
    if (!byAlbum.has(t.albumId)) byAlbum.set(t.albumId, []);
    byAlbum.get(t.albumId).push(t);
  }
  const groups = shuffle([...byAlbum.values()].map((g) => shuffle(g)));
  const out = [];
  let total = 0;
  let i = 0;
  let guard = 0;
  while (groups.some((g) => g.length) && guard++ < 5000) {
    const g = groups[i % groups.length];
    i++;
    if (!g.length) continue;
    const t = g.shift();
    out.push(t);
    total += t.duration || 240;
    if (total >= targetSeconds) break;
  }
  return out;
}

// Scarta quello che non e' un genere: residui di rippatura con suffisso numerico
// ("indie.1", "rock.1"), etichette tecniche ("flacnostrings") e i non-generi.
const NON_GENERI = new Set(['other', 'others', 'unknown', 'various', 'misc', 'genre', 'altro', 'varie']);

function tagUtile(nome) {
  if (/\.\d+$/.test(nome)) return false;
  if (/^(flac|mp3|wav|ape)\w*$/i.test(nome)) return false;
  const n = normalize(nome);
  return n.length >= 2 && !NON_GENERI.has(n);
}

// Un tag solo puo' contenere una lista ("Folk-Rock, Celtic, Indie Folk"): per il
// menu la si spacchetta, cosi' le voci offerte sono generi veri. La virgola e il
// punto e virgola sono separatori sicuri; la barra no, perche' "Pop/Rock" e
// "Singer/Songwriter" sono generi interi.
function generiDelTag(tag) {
  return String(tag)
    .split(/[,;]+/)
    .map((p) => p.trim())
    .filter((p) => p && tagUtile(p));
}

function decadeLabel(yearMin, yearMax) {
  if (!Number.isFinite(yearMin)) return '';
  const d = Math.floor(yearMin / 10) * 10;
  if (d >= 2000) return 'anni ' + d;
  return "anni '" + String(d).slice(-2);
}

function describeCriteria(criteria) {
  if (criteria.mode === 'genre' && criteria.genre) return 'Genere: ' + criteria.genre;
  if (criteria.mode === 'decade') return decadeLabel(criteria.yearMin, criteria.yearMax) || 'Un decennio';
  if (criteria.mode === 'years' && criteria.yearMin) {
    return criteria.yearMax && criteria.yearMax !== criteria.yearMin
      ? 'Anni ' + criteria.yearMin + '–' + criteria.yearMax
      : 'Anno ' + criteria.yearMin;
  }
  if (criteria.mode === 'mixed') return 'Filo conduttore libero';
  return 'Pescata libera da tutta la libreria';
}

function fallbackTitle(criteria) {
  if (criteria.mode === 'genre' && criteria.genre) return 'Solco ' + criteria.genre;
  if (criteria.mode === 'decade') {
    const lbl = decadeLabel(criteria.yearMin, criteria.yearMax);
    return lbl ? 'Solco ' + lbl : 'Solco di un decennio';
  }
  if (criteria.mode === 'years' && criteria.yearMin) return 'Solco ' + criteria.yearMin + (criteria.yearMax && criteria.yearMax !== criteria.yearMin ? '–' + criteria.yearMax : '');
  if (criteria.mode === 'mixed') return 'Solco a briglia sciolta';
  return 'Solco casuale';
}

function fallbackDescription(criteria, tracks) {
  const artisti = [...new Set(tracks.map((t) => t.artist))].slice(0, 3).join(', ');
  const base = describeCriteria(criteria).toLowerCase();
  return 'Puntata generata senza modello linguistico: ' + base + '. In scaletta anche ' + (artisti || 'diversi artisti della tua libreria') + '.';
}

/* ---------------- prompt per il modello ---------------- */

function formatSystemPrompt() {
  return [
    'Sei il curatore autonomo di "Radio Solco", una web radio che trasmette',
    'ESCLUSIVAMENTE dalla libreria musicale personale di chi ascolta.',
    'Decidi TU, senza chiedere nulla all\'ascoltatore, il taglio della puntata di oggi.',
    'Modalita\' possibili:',
    '- "random": pescata libera da tutta la libreria',
    '- "genre": monografica su UN genere realmente presente in libreria',
    '- "decade": un decennio preciso (es. anni \'80, anni \'90, anni 2000)',
    '- "years": un intervallo di anni piu\' stretto',
    '- "mixed": un filo conduttore libero che intreccia piu\' generi o epoche',
    'Con "mixed" il filo conduttore deve essere dichiarato nella descrizione in',
    'modo che si capisca quali brani ci stanno e quali no.',
    'Sempre con "mixed", in "keywords" elenca le parole con cui si riconoscono i',
    'brani adatti leggendone titolo, album e artista: mettile nella lingua in cui',
    'sono scritti i titoli (di solito inglese) e aggiungi le corrispondenti',
    'italiane. Parole concrete, non generiche: per un tema sulla pioggia',
    '["rain", "rainy", "storm", "thunder", "umbrella", "pioggia", "temporale"],',
    'non ["musica", "canzone", "bella"].',
    'Ti fornisco i generi disponibili con quanti brani hanno, l\'arco di anni',
    'coperto e i titoli delle ultime puntate andate in onda: scegli qualcosa che',
    'se ne discosti. Il genere, se lo usi, va copiato esattamente dall\'elenco.',
    'Rispondi SOLO con un oggetto JSON in questa forma esatta, senza altro testo:',
    '{',
    '  "mode": "random" | "genre" | "decade" | "years" | "mixed",',
    '  "genre": <nome di un genere dall\'elenco, oppure null>,',
    '  "yearMin": <anno minimo intero, oppure null>,',
    '  "yearMax": <anno massimo intero, oppure null>,',
    '  "keywords": [<da 5 a 12 parole per riconoscere i brani adatti; vuoto se non serve>],',
    '  "motivo": "<una frase sul PERCHE\' hai scelto questo taglio oggi, in italiano>",',
    '  "title": "<titolo breve ed evocativo della puntata, in italiano>",',
    '  "description": "<2 o 3 frasi di presentazione, tono da conduttore radiofonico, in italiano>"',
    '}'
  ].join('\n');
}

function tracklistSystemPrompt(conTitolo) {
  const testa = conTitolo
    ? [
      'Sei il curatore di "Radio Solco". Il taglio e il titolo della puntata sono',
      'gia\' stati decisi e te li passo: il tuo compito e\' scegliere i brani che',
      'realizzano QUEL filo conduttore, non inventarne un altro.'
    ]
    : [
      'Sei il curatore di "Radio Solco". Il taglio della puntata l\'ha scelto',
      'l\'ascoltatore e te lo passo: scegli i brani e dai un titolo alla puntata.'
    ];
  return testa.concat([
    'Scegli SOLO dall\'elenco numerato che ricevi (usa esclusivamente gli indici',
    'presenti). Vincoli:',
    '- Ogni brano deve avere un motivo per stare in questa puntata e non in',
    '  un\'altra: se il filo conduttore e\' un tema, rispettalo davvero.',
    '- Durata totale il piu\' vicino possibile a 45 minuti (accettabile 40–50).',
    '- Ordina i brani come una vera trasmissione: un\'apertura che cattura,',
    '  alternanza di intensita\' e atmosfere, una chiusura coerente.',
    '- Evita di usare lo stesso artista piu\' di due volte, quando puoi.',
    '- Non inventare mai indici, titoli o brani fuori dall\'elenco.',
    'Rispondi SOLO con un oggetto JSON in questa forma, senza altro testo:',
    '{ "chosen": [<indici interi, nell\'ordine di trasmissione>],',
    conTitolo ? '' : '  "title": "<titolo breve ed evocativo della puntata, in italiano>",',
    '  "description": "<presentazione breve in italiano, tono radiofonico, che',
    '   racconti il filo conduttore attraverso i brani scelti>" }'
  ]).filter(Boolean).join('\n');
}

// Quando il tema lo scrive l'ascoltatore il modello non deve inventarne un altro:
// deve tradurre il suo in qualcosa con cui si riconoscano i brani. Serve perche'
// il tema arriva in italiano e i titoli in libreria sono quasi tutti in inglese.
function temaSystemPrompt() {
  return [
    'Sei il curatore di "Radio Solco", una web radio che trasmette ESCLUSIVAMENTE',
    'dalla libreria musicale personale di chi ascolta. Il tema della puntata di',
    'oggi l\'ha scritto l\'ascoltatore: NON sceglierne un altro, traduci il suo.',
    'In "keywords" elenca le parole con cui si riconoscono i brani adatti leggendone',
    'titolo, album e artista: mettile nella lingua in cui sono scritti i titoli (di',
    'solito inglese) e aggiungi le corrispondenti italiane. Parole concrete, non',
    'generiche: per "canzoni sotto la pioggia" ["rain", "rainy", "storm", "thunder",',
    '"umbrella", "pioggia", "temporale"], non ["musica", "canzone", "bella"].',
    'Se il tema nomina un genere o un periodo precisi, compila anche "mode",',
    '"genre", "yearMin" e "yearMax" per restringere la ricerca: il genere va',
    'copiato esattamente dall\'elenco che ti do. Altrimenti lascia "mixed" e null.',
    'Il titolo e la descrizione devono parlare del tema chiesto, non di altro.',
    'Rispondi SOLO con un oggetto JSON in questa forma esatta, senza altro testo:',
    '{',
    '  "mode": "mixed" | "genre" | "decade" | "years",',
    '  "genre": <nome di un genere dall\'elenco, oppure null>,',
    '  "yearMin": <anno minimo intero, oppure null>,',
    '  "yearMax": <anno massimo intero, oppure null>,',
    '  "keywords": [<da 5 a 12 parole per riconoscere i brani adatti>],',
    '  "motivo": "<una frase su come hai interpretato il tema chiesto, in italiano>",',
    '  "title": "<titolo breve ed evocativo della puntata, in italiano>",',
    '  "description": "<2 o 3 frasi di presentazione, tono da conduttore radiofonico, in italiano>"',
    '}'
  ].join('\n');
}

/* ---------------- servizio ---------------- */

function createRadioSolcoService(deps) {
  const webInfo = (deps && deps.webInfo) || null;

  // I generi offerti al modello sono un menu, non l'elenco grezzo dei tag: si
  // scartano i residui di rippatura ("indie.1", "flacnostrings"), si uniscono le
  // grafie che coincidono una volta normalizzate (Folk-Rock, Folk/Rock, Folk Rock)
  // e si tengono solo quelli con abbastanza brani da reggere una puntata.
  // La corrispondenza resta larga: buildPool cerca comunque fra TUTTI i tag veri.
  function generiProponibili(allTracks) {
    // 1. raggruppa le grafie equivalenti; fra quelle di un gruppo vince la piu' usata
    const perNorma = new Map();
    for (const t of allTracks) {
      for (const g of t.genre || []) {
        for (const nome of generiDelTag(g)) {
          const chiave = normalize(nome);
          if (!chiave) continue;
          let voce = perNorma.get(chiave);
          if (!voce) {
            voce = { grafie: new Map() };
            perNorma.set(chiave, voce);
          }
          voce.grafie.set(nome, (voce.grafie.get(nome) || 0) + 1);
        }
      }
    }
    const candidati = [...perNorma.values()].map((v) => {
      const grafie = [...v.grafie.entries()].sort((a, b) => b[1] - a[1]);
      return { nome: grafie[0][0], usi: grafie.reduce((n, g) => n + g[1], 0) };
    });

    // 2. conta i brani che finirebbero davvero nel pool. Non basta contare chi ha
    //    quel tag esatto: chiedendo "Folk" buildPool prende anche Folk Rock e Folk
    //    Pop, quindi un genere con pochi tag propri puo' comunque reggere.
    const tagReali = [...new Set(allTracks.flatMap((t) => t.genre || []).filter(Boolean))];
    const tagDelCandidato = new Map();
    for (const c of candidati) {
      tagDelCandidato.set(c.nome, tagReali.filter((tag) => fuzzyIncludes(c.nome, tag)));
    }
    const candidatiPerTag = new Map(tagReali.map((tag) => [tag, []]));
    for (const c of candidati) {
      for (const tag of tagDelCandidato.get(c.nome)) candidatiPerTag.get(tag).push(c.nome);
    }
    const brani = new Map(candidati.map((c) => [c.nome, 0]));
    for (const t of allTracks) {
      const suoi = new Set();
      for (const tag of t.genre || []) {
        for (const nome of candidatiPerTag.get(tag) || []) suoi.add(nome);
      }
      for (const nome of suoi) brani.set(nome, brani.get(nome) + 1);
    }

    // 3. due voci che pescherebbero gli stessi identici tag sono la stessa voce:
    //    "Progressive Rock", "Rock Prog" e "prog-rock" non vanno offerte tutte e
    //    tre. Resta la grafia piu' usata nei tag, a parita' la piu' breve.
    const perInsieme = new Map();
    for (const c of candidati) {
      const firma = tagDelCandidato.get(c.nome).slice().sort().join('\u0000');
      const attuale = perInsieme.get(firma);
      const meglio = !attuale || c.usi > attuale.usi ||
        (c.usi === attuale.usi && c.nome.length < attuale.nome.length);
      if (meglio) perInsieme.set(firma, c);
    }

    return [...perInsieme.values()]
      .map((c) => ({ nome: c.nome, brani: brani.get(c.nome) }))
      .filter((g) => g.brani >= MIN_BRANI_PER_GENERE)
      .sort((a, b) => b.brani - a.brani);
  }

  function librarySnapshot(allTracks) {
    const proponibili = generiProponibili(allTracks);
    // Anni palesemente sbagliati nei tag (qualche album ha "1") non devono
    // diventare l'estremo dell'arco mostrato al modello.
    const years = allTracks.map((t) => t.year).filter((y) => Number.isFinite(y) && y >= ANNO_MINIMO);
    return {
      genres: proponibili.map((g) => g.nome),
      genreCounts: proponibili,
      yearMin: years.length ? Math.min(...years) : null,
      yearMax: years.length ? Math.max(...years) : null,
      trackCount: allTracks.length
    };
  }

  // Corrispondenza a senso unico, la stessa delle playlist IA: "folk rock" prende
  // Folk Rock, Folk-Rock e Folk/Rock, ma NON il generico Rock. Il confronto nei due
  // sensi faceva l'opposto: chiedendo "Folk Rock" bastava che "rock" fosse contenuto
  // nella richiesta perche' l'intero genere Rock venisse considerato buono.
  function matchGenre(rawGenre, realGenres) {
    const want = String(rawGenre || '').trim();
    if (!normalize(want)) return [];
    return realGenres.filter((g) => fuzzyIncludes(want, g));
  }

  function normalizeCriteria(raw, snap) {
    const mode = MODES.includes(raw && raw.mode) ? raw.mode : 'random';
    const criteria = {
      mode,
      genre: null,
      yearMin: null,
      yearMax: null,
      keywords: pulisciParoleChiave(raw && raw.keywords)
    };
    const realGenres = snap.genres;

    if (mode === 'genre') {
      const richiesto = String(raw.genre || '').trim();
      const hits = matchGenre(richiesto, realGenres);
      if (hits.length) {
        // L'etichetta e' il genere chiesto, non il primo tag che gli somiglia:
        // una puntata su "Folk Rock" non deve presentarsi come "Genere: Rock".
        // Se in libreria esiste un tag che coincide, se ne prende la grafia.
        const uguale = hits.find((g) => normalize(g) === normalize(richiesto));
        criteria.genre = uguale || richiesto;
        criteria.genreVariants = hits;
      } else {
        criteria.mode = 'random';
      }
    }
    if (mode === 'decade' || mode === 'years') {
      let lo = Number.isFinite(raw.yearMin) ? Math.round(raw.yearMin) : null;
      let hi = Number.isFinite(raw.yearMax) ? Math.round(raw.yearMax) : null;
      if (mode === 'decade') {
        const base = lo || hi;
        if (Number.isFinite(base)) {
          lo = Math.floor(base / 10) * 10;
          hi = lo + 9;
        }
      }
      if (lo && !hi) hi = lo;
      if (hi && !lo) lo = hi;
      // La stessa soglia che il ripiego del server applica gia': un tag "1" non
      // deve diventare l'estremo di un intervallo di anni.
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo && lo >= ANNO_MINIMO) {
        criteria.yearMin = lo;
        criteria.yearMax = hi;
      } else {
        criteria.mode = 'random';
      }
    }
    return criteria;
  }

  function buildPool(allTracks, criteria) {
    let pool = allTracks;
    if (criteria.mode === 'genre') {
      const variants = new Set((criteria.genreVariants || [criteria.genre]).map((g) => String(g).toLowerCase()));
      pool = pool.filter((t) => (t.genre || []).some((g) => variants.has(g.toLowerCase())));
    } else if (criteria.mode === 'decade' || criteria.mode === 'years') {
      pool = pool.filter((t) => Number.isFinite(t.year) && t.year >= ANNO_MINIMO &&
        t.year >= criteria.yearMin && t.year <= criteria.yearMax);
    }
    return pool;
  }

  // Sceglie autonomamente il taglio della puntata. Se il modello non e'
  // disponibile o non risponde, decide il server tirando a sorte una modalita'.
  async function chooseFormat(snap, avoidTitles) {
    if (webInfo) {
      const userPrompt = [
        'Generi disponibili in libreria (fra parentesi i brani): ' + (snap.genreCounts.length
          ? snap.genreCounts.map((g) => g.nome + ' (' + g.brani + ')').join(', ')
          : 'nessun genere utilizzabile nei tag'),
        'Anni coperti: ' + (snap.yearMin ? snap.yearMin + '–' + snap.yearMax : 'non disponibili'),
        'Brani totali in libreria: ' + snap.trackCount,
        'Titoli delle ultime puntate andate in onda (da NON ripetere come tema):',
        avoidTitles && avoidTitles.length ? avoidTitles.map((t) => '- ' + t).join('\n') : '- nessuna puntata precedente'
      ].join('\n');
      const res = await webInfo.chatJSON(formatSystemPrompt(), userPrompt, {
        temperature: 0.9,
        maxTokens: 400,
        timeoutMs: 120000
      });
      if (res.ok && res.data) {
        return {
          raw: res.data,
          ai: { used: true, provider: res.provider, model: res.model }
        };
      }
      return {
        raw: null,
        ai: { used: false, provider: res.provider || null, model: res.model || null, reason: res.reason || 'modello non disponibile' }
      };
    }
    return { raw: null, ai: { used: false, provider: null, model: null, reason: 'modello non configurato' } };
  }

  // Una sola chiamata: dal tema scritto dall'utente ricava parole chiave, titolo,
  // descrizione ed eventualmente un genere o un periodo con cui stringere il pool.
  async function espandiTema(tema, snap) {
    const userPrompt = [
      'Tema chiesto dall\'ascoltatore: ' + tema,
      'Generi disponibili in libreria (fra parentesi i brani): ' + (snap.genreCounts.length
        ? snap.genreCounts.map((g) => g.nome + ' (' + g.brani + ')').join(', ')
        : 'nessun genere utilizzabile nei tag'),
      'Anni coperti: ' + (snap.yearMin ? snap.yearMin + '–' + snap.yearMax : 'non disponibili')
    ].join('\n');
    return webInfo.chatJSON(temaSystemPrompt(), userPrompt, {
      temperature: 0.7,
      maxTokens: 400,
      timeoutMs: 120000
    });
  }

  // Costruisce la scaletta vera e propria a partire dai candidati.
  // `tema` e' quello deciso al primo passaggio. Senza, la modalita' "filo
  // conduttore" era una pescata casuale: il secondo passaggio vedeva solo
  // l'etichetta "Filo conduttore libero" e non sapeva quale fosse il filo.
  async function chooseTracklist(candidates, criteria, aiActive, tema) {
    if (webInfo && aiActive) {
      const listText = candidates
        .map((t, i) => (i + 1) + ') ' + t.artist + ' - ' + t.title + ' (' + t.album + (t.year ? ', ' + t.year : '') + ') - ' + fmtDuration(t.duration))
        .join('\n');
      const intestazione = ['Taglio scelto per la puntata: ' + describeCriteria(criteria) + '.'];
      if (tema && tema.title) intestazione.push('Titolo della puntata: "' + tema.title + '".');
      if (tema && tema.description) {
        intestazione.push('Filo conduttore annunciato agli ascoltatori, da rispettare nella scelta:');
        intestazione.push(tema.description);
      }
      if (tema && tema.aTema) {
        intestazione.push('I primi ' + tema.aTema + ' brani dell\'elenco sono quelli che richiamano il tema,' +
          ' dai piu\' pertinenti in giu\': costruisci la puntata soprattutto con quelli, gli altri servono' +
          ' per varieta\' e per arrivare alla durata giusta. Il tema non e\' una parola da ripetere:' +
          ' varia gli aspetti che tocchi invece di prendere otto titoli che dicono la stessa cosa.');
      }
      const userPrompt = [
        intestazione.join('\n'),
        'Brani candidati (usa solo questi numeri):',
        listText
      ].join('\n\n');
      const res = await webInfo.chatJSON(tracklistSystemPrompt(!!(tema && tema.title)), userPrompt, {
        temperature: 0.6,
        maxTokens: 600,
        timeoutMs: 180000
      });
      if (res.ok && res.data && Array.isArray(res.data.chosen)) {
        const seen = new Set();
        const picked = [];
        for (const idx of res.data.chosen) {
          const i = Number(idx) - 1;
          if (Number.isInteger(i) && i >= 0 && i < candidates.length && !seen.has(i)) {
            seen.add(i);
            picked.push(candidates[i]);
          }
        }
        if (picked.length) {
          return {
            tracks: picked,
            title: String(res.data.title || '').trim(),
            description: String(res.data.description || '').trim(),
            aiUsed: true,
            provider: res.provider || null,
            model: res.model || null
          };
        }
      }
    }
    // ripiego deterministico
    return {
      tracks: roundRobinByAlbum(candidates, TARGET_SECONDS),
      title: '',
      description: '',
      aiUsed: false
    };
  }

  // Evita che un singolo artista monopolizzi la puntata: se fra i candidati c'e'
  // varieta' sufficiente, tiene al massimo 3 brani per artista e rimpiazza gli
  // altri pescando dal pool.
  function enforceArtistVariety(tracks, pool) {
    const distinctArtists = new Set(pool.map((t) => (t.albumArtist || t.artist || '').toLowerCase()));
    // Il tetto si applica sempre, anche quando il pool ha pochi artisti: tagliare
    // qui e lasciare che fitDuration riallunghi (prima con artisti sotto il tetto,
    // poi con gli altri) da' una puntata piu' varia di quanta ne desse la vecchia
    // soglia fissa a 6, che su "Celtic" lasciava passare sette Iona su dieci.
    if (distinctArtists.size < 2) return tracks;

    const cap = MAX_PER_ARTIST;
    const perArtist = new Map();
    const kept = [];
    const overflow = [];
    for (const t of tracks) {
      const key = (t.albumArtist || t.artist || '').toLowerCase();
      const n = perArtist.get(key) || 0;
      if (n < cap) {
        perArtist.set(key, n + 1);
        kept.push(t);
      } else {
        overflow.push(t);
      }
    }
    if (!overflow.length) return tracks;

    const used = new Set(kept.map(trackKey));
    const spare = shuffle(pool.filter((t) => {
      const key = (t.albumArtist || t.artist || '').toLowerCase();
      return !used.has(trackKey(t)) && (perArtist.get(key) || 0) < cap;
    }));
    for (const t of spare) {
      if (!overflow.length) break;
      const key = (t.albumArtist || t.artist || '').toLowerCase();
      if ((perArtist.get(key) || 0) >= cap) continue;
      perArtist.set(key, (perArtist.get(key) || 0) + 1);
      used.add(trackKey(t));
      kept.push(t);
      overflow.pop();
    }
    return kept;
  }

  // Porta la durata dentro la finestra 38–52 minuti: taglia gli ultimi brani se
  // eccede, allunga pescando dal resto del pool se e' troppo corta.
  function fitDuration(tracks, poolRest) {
    let out = tracks.slice();
    let total = out.reduce((s, t) => s + (t.duration || 240), 0);

    while (out.length > 1 && total > MAX_SECONDS) {
      total -= out[out.length - 1].duration || 240;
      out.pop();
    }

    if (total < MIN_SECONDS && poolRest.length) {
      const used = new Set(out.map(trackKey));
      const chiave = (t) => (t.albumArtist || t.artist || '').toLowerCase();
      const perArtista = new Map();
      for (const t of out) perArtista.set(chiave(t), (perArtista.get(chiave(t)) || 0) + 1);
      const extra = shuffle(poolRest.filter((t) => !used.has(trackKey(t))));
      // Due giri: prima chi sta sotto il tetto per artista, poi tutti gli altri.
      // Senza il primo giro l'allungamento disfaceva il lavoro di
      // enforceArtistVariety; senza il secondo la puntata resterebbe monca.
      for (const giro of [0, 1]) {
        for (const t of extra) {
          if (total >= TARGET_SECONDS) break;
          if (used.has(trackKey(t))) continue;
          const durata = t.duration || 240;
          // un brano lungo non deve far sfondare il tetto dei 52 minuti
          if (total + durata > MAX_SECONDS) continue;
          const k = chiave(t);
          if (!giro && (perArtista.get(k) || 0) >= MAX_PER_ARTIST) continue;
          used.add(trackKey(t));
          perArtista.set(k, (perArtista.get(k) || 0) + 1);
          out.push(t);
          total += durata;
        }
        if (total >= TARGET_SECONDS) break;
      }
    }
    return out;
  }

  // Garantisce che la scaletta non coincida con nessuna gia' memorizzata.
  // Sostituisce qualche brano alla volta pescando dal pool, senza vietare i
  // singoli brani gia' trasmessi: cambia solo l'insieme, non i suoi elementi
  // uno per uno.
  function ensureDistinct(tracks, pool, avoidSignatures) {
    const avoid = new Set(avoidSignatures || []);
    let out = tracks.slice();
    if (!avoid.has(signatureOf(out))) return { tracks: out, forcedRepeat: false };

    for (let attempt = 0; attempt < 15; attempt++) {
      const used = new Set(out.map(trackKey));
      const spare = shuffle(pool.filter((t) => !used.has(trackKey(t))));
      if (!spare.length) break;
      const swaps = Math.min(3, spare.length, out.length - 1);
      for (let k = 0; k < swaps; k++) {
        out[out.length - 1 - k] = spare[k];
      }
      if (!avoid.has(signatureOf(out))) return { tracks: out, forcedRepeat: false };
    }
    return { tracks: out, forcedRepeat: true };
  }

  // Quello che il menu dell'interfaccia puo' proporre: generi e decenni che in
  // libreria hanno abbastanza materiale per reggere una puntata.
  function opzioni(albums) {
    const allTracks = flattenTracks(albums).filter((t) => Number.isFinite(t.duration) && t.duration > 0);
    const snap = librarySnapshot(allTracks);
    const perDecennio = new Map();
    for (const t of allTracks) {
      if (!Number.isFinite(t.year) || t.year < ANNO_MINIMO) continue;
      const d = Math.floor(t.year / 10) * 10;
      perDecennio.set(d, (perDecennio.get(d) || 0) + 1);
    }
    const decades = [...perDecennio.entries()]
      .filter(([, n]) => n >= MIN_BRANI_PER_GENERE)
      .sort((a, b) => a[0] - b[0])
      .map(([decade, brani]) => ({ decade, brani, label: decadeLabel(decade) }));
    return {
      genres: snap.genreCounts,
      decades,
      yearMin: snap.yearMin,
      yearMax: snap.yearMax,
      trackCount: allTracks.length
    };
  }

  async function produce(albums, options) {
    const opts = options || {};
    const avoidSignatures = opts.avoidSignatures || [];
    const avoidTitles = opts.avoidTitles || [];

    const allTracks = flattenTracks(albums).filter((t) => Number.isFinite(t.duration) && t.duration > 0);
    if (allTracks.length < 8) {
      return { ok: false, error: 'La libreria ha troppi pochi brani con durata nota per una puntata di Radio Solco.' };
    }

    const snap = librarySnapshot(allTracks);
    const warnings = [];

    // Taglio scelto dall'ascoltatore: si salta il primo passaggio del modello,
    // che serviva solo a decidere cosa trasmettere. Col tema scritto da lui il
    // passaggio resta, ma cambia mestiere: non sceglie, traduce.
    const chiesto = opts.request || null;
    const temaUtente = chiesto && chiesto.mode === 'theme' ? String(chiesto.theme || '').trim() : '';
    const richiesta = !temaUtente && chiesto && MODES.includes(chiesto.mode) ? chiesto : null;

    let format;
    if (temaUtente) {
      if (!webInfo) {
        return { ok: false, error: 'Per un tema scritto da te serve il modello linguistico: configuralo in Impostazioni IA.' };
      }
      const esito = await espandiTema(temaUtente, snap);
      if (!esito.ok || !esito.data) {
        return { ok: false, error: 'Il modello non ha saputo interpretare il tema (' + (esito.reason || 'nessuna risposta') + ').' };
      }
      format = { raw: esito.data, ai: { used: true, provider: esito.provider, model: esito.model } };
    } else if (richiesta) {
      format = { raw: null, scelto: true, ai: { used: false, provider: null, model: null } };
    } else {
      format = await chooseFormat(snap, avoidTitles);
    }

    let criteria;
    let title = '';
    let description = '';
    let motivo = '';

    if (richiesta) {
      criteria = normalizeCriteria(richiesta, snap);
      if (criteria.mode !== richiesta.mode) {
        warnings.push('Il taglio richiesto non era applicabile alla tua libreria: ripiego su una selezione libera.');
      }
    } else if (format.raw) {
      criteria = normalizeCriteria(format.raw, snap);
      title = String(format.raw.title || '').trim();
      description = String(format.raw.description || '').trim();
      motivo = String(format.raw.motivo || '').trim().slice(0, 300);
      if (criteria.mode !== (format.raw.mode || 'random')) {
        warnings.push(temaUtente
          ? 'Il genere o il periodo ricavati dal tema non erano applicabili alla tua libreria: conta solo il tema.'
          : 'Il taglio proposto dal modello non era applicabile alla tua libreria: ripiego su una selezione libera.');
      }
    } else {
      // scelta del server: modalita' a sorte, coerente con cio' che la libreria offre.
      // I decenni sono ricavati dai soli anni con abbastanza materiale, cosi' un
      // tag sballato (es. "1400") non diventa il taglio della puntata.
      const decadeCount = new Map();
      for (const t of allTracks) {
        if (!Number.isFinite(t.year) || t.year < 1900) continue;
        const d = Math.floor(t.year / 10) * 10;
        decadeCount.set(d, (decadeCount.get(d) || 0) + 1);
      }
      const goodDecades = [...decadeCount.entries()].filter(([, n]) => n >= 15).map(([d]) => d);
      const modeChoices = ['random'];
      if (snap.genres.length) modeChoices.push('genre', 'genre');
      if (goodDecades.length) modeChoices.push('decade', 'decade');
      const pick = modeChoices[Math.floor(Math.random() * modeChoices.length)];
      const raw = { mode: pick };
      if (pick === 'genre') raw.genre = snap.genres[Math.floor(Math.random() * snap.genres.length)];
      if (pick === 'decade') {
        raw.yearMin = goodDecades[Math.floor(Math.random() * goodDecades.length)];
      }
      criteria = normalizeCriteria(raw, snap);
      if (format.ai.reason) warnings.push('Modello linguistico non disponibile (' + format.ai.reason + '): la puntata è stata montata dal server.');
    }

    let pool = buildPool(allTracks, criteria);
    if (pool.length < 10) {
      if (criteria.mode !== 'random') {
        warnings.push('Il taglio scelto (' + describeCriteria(criteria).toLowerCase() + ') aveva troppo pochi brani: puntata allargata a tutta la libreria.');
      }
      criteria = { mode: 'random', genre: null, yearMin: null, yearMax: null };
      pool = allTracks;
    }

    const selezione = criteria.keywords && criteria.keywords.length
      ? candidatiPerTema(pool, criteria.keywords, CANDIDATE_CAP)
      : { candidates: sampleDiverse(pool, CANDIDATE_CAP), aTema: 0 };
    const candidates = selezione.candidates;
    if (temaUtente) {
      // Con un tema tuo non ha senso servire una pescata a caso sotto il tuo
      // titolo: meglio dirlo e non spendere la seconda chiamata al modello.
      if (!criteria.keywords.length && (criteria.mode === 'mixed' || criteria.mode === 'random')) {
        return { ok: false, error: 'Dal tema «' + temaUtente + '» non sono uscite parole con cui cercare. Prova a scriverlo in modo più concreto.' };
      }
      if (criteria.keywords.length && selezione.aTema < MIN_BRANI_A_TEMA) {
        return {
          ok: false,
          error: (selezione.aTema
            ? 'Solo ' + selezione.aTema + (selezione.aTema === 1 ? ' brano richiama' : ' brani richiamano') + ' «' + temaUtente + '»: troppo pochi per una puntata.'
            : 'Nessun brano della tua libreria richiama «' + temaUtente + '».') +
            ' Ho cercato: ' + criteria.keywords.join(', ') + '. Prova con un tema diverso.'
        };
      }
    } else if (criteria.keywords && criteria.keywords.length && selezione.aTema < MIN_BRANI_A_TEMA) {
      warnings.push('Pochi brani della libreria richiamano il tema scelto: la scaletta è in gran parte una selezione libera.');
    }
    if (criteria.keywords && criteria.keywords.length &&
        selezione.aTema >= MIN_BRANI_A_TEMA && selezione.aTema < TEMA_DEBOLE) {
      warnings.push('Il tema ha agganciato solo ' + selezione.aTema +
        ' brani in libreria: il resto della scaletta è scelto per andamento e durata.');
    }
    // Col taglio scelto dall'utente il modello non ha parlato al primo passaggio,
    // ma serve lo stesso per la scaletta: si prova, e se non risponde si ripiega.
    const aiActive = format.scelto ? !!webInfo : !!format.raw;
    const picked = await chooseTracklist(candidates, criteria, aiActive, {
      title,
      description,
      aTema: selezione.aTema
    });
    if (!picked.aiUsed && aiActive) {
      warnings.push('Il modello non ha risposto per la scaletta: ordine e brani scelti dal server.');
    }
    if (format.scelto && !webInfo) {
      warnings.push('Modello linguistico non configurato: la puntata è stata montata dal server.');
    }
    // Il titolo resta quello del primo passaggio: e' lui a definire il taglio, e
    // il secondo lo riceve gia' fatto. La descrizione invece si aggiorna, perche'
    // il secondo passaggio e' l'unico che conosce la scaletta davvero trasmessa.
    if (!title && picked.title) title = picked.title;
    if (picked.description) description = picked.description;

    let tracks = enforceArtistVariety(picked.tracks, pool);
    tracks = fitDuration(tracks, pool);

    const distinct = ensureDistinct(tracks, pool, avoidSignatures);
    tracks = distinct.tracks;
    if (distinct.forcedRepeat) {
      warnings.push('La libreria non basta a comporre una scaletta del tutto nuova: questa puntata coincide con una già memorizzata.');
    }

    if (!title) title = fallbackTitle(criteria);
    if (!description) description = fallbackDescription(criteria, tracks);

    const totalSeconds = tracks.reduce((s, t) => s + (t.duration || 0), 0);
    const cleanTracks = tracks.map((t) => ({
      albumId: t.albumId,
      index: t.index,
      title: t.title,
      artist: t.artist,
      album: t.album,
      year: t.year || null,
      cover: !!t.cover,
      duration: Number.isFinite(t.duration) ? Math.round(t.duration) : null
    }));

    return {
      ok: true,
      episode: {
        title: title.slice(0, 160),
        description: description.slice(0, 800),
        mode: criteria.mode,
        criteriaLabel: describeCriteria(criteria),
        criteria: {
          mode: criteria.mode,
          genre: criteria.genre,
          yearMin: criteria.yearMin,
          yearMax: criteria.yearMax,
          // le parole con cui il server ha davvero filtrato i candidati: senza
          // salvarle la scheda non puo' spiegare perche' ci sono quei brani
          keywords: criteria.keywords && criteria.keywords.length ? criteria.keywords : null
        },
        motivo: motivo || null,
        tracks: cleanTracks,
        trackCount: cleanTracks.length,
        totalSeconds,
        signature: signatureOf(cleanTracks),
        ai: format.ai.used || picked.aiUsed
          ? {
            used: true,
            provider: format.ai.provider || picked.provider || null,
            model: format.ai.model || picked.model || null
          }
          : { used: false, provider: format.ai.provider || null, model: format.ai.model || null },
        chosenBy: richiesta || temaUtente ? 'utente' : 'ia',
        requestedTheme: temaUtente || null,
        themeMatches: criteria.keywords && criteria.keywords.length ? selezione.aTema : null,
        warnings
      }
    };
  }

  return { produce, opzioni, signatureOf };
}

module.exports = { createRadioSolcoService, signatureOf };
