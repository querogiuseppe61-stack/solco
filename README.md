# Solco

Solco è un lettore musicale per la propria collezione di album. Gira in locale:
un piccolo server Node indicizza le cartelle di musica e l'interfaccia si apre nel
browser. Oltre alla riproduzione offre schede su album e artisti (MusicBrainz e
Wikipedia, con sintesi facoltativa scritta da un modello IA), playlist generate
dall'IA, la "Radio Solco" e l'analisi del suono dei brani (umore, energia,
ballabilità) con modelli Essentia.

## Requisiti

- **Node.js 18 o superiore** (serve `fetch()` integrato).
- **ffmpeg**, facoltativo: serve solo per l'analisi audio dei brani. Se manca, il
  resto dell'app funziona normalmente.
  - Windows: `winget install Gyan.FFmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: dal gestore pacchetti della distribuzione (es. `apt install ffmpeg`)
- Per le sintesi e le playlist IA, facoltativi: [LM Studio](https://lmstudio.ai) in
  locale oppure una chiave [OpenRouter](https://openrouter.ai).

## Avvio

Al primo avvio gli script installano da soli le dipendenze (`npm install`, serve
la rete una volta sola), avviano il server e aprono il browser su
<http://localhost:3747>.

| Sistema | Come avviarlo |
| --- | --- |
| Windows | doppio clic su `Avvia Solco.bat` |
| macOS | doppio clic su `Avvia Solco.command` (se il Finder non lo esegue: `chmod +x "Avvia Solco.command"`) |
| Linux | `./avvia-solco.sh` dal terminale, nella cartella dell'app |

In alternativa, da qualsiasi sistema:

```bash
npm install
npm start
```

Per fermare il server: Ctrl-C nel terminale, oppure chiudere la finestra.

### Lanciatore nel menu (Linux)

`Solco.desktop` è solo un modello: i percorsi vengono inseriti al momento
dell'installazione. Per aggiungere Solco al menu delle applicazioni:

```bash
./avvia-solco.sh --installa
```

Il lanciatore viene scritto in `~/.local/share/applications/solco.desktop` con i
percorsi della cartella in cui si trova l'app. Se sposti la cartella, rilancia lo
stesso comando. Per averlo anche sulla scrivania basta copiare quel file e, se
l'ambiente desktop lo chiede, consentirne l'avvio.

## La musica

Gli album messi nella cartella `music/` dell'app vengono trovati automaticamente.
Altre cartelle (anche su dischi esterni) si aggiungono dall'interfaccia con
**Indicizza musica**; l'elenco viene salvato in `library.json`.

## Variabili d'ambiente

Tutte facoltative.

| Variabile | Predefinito | A cosa serve |
| --- | --- | --- |
| `PORT` | `3747` | Porta del server. |
| `SOLCO_HOST` | `127.0.0.1` | Indirizzo su cui ascolta il server. Con `0.0.0.0` Solco diventa raggiungibile dalla rete locale: farlo solo su reti fidate. |
| `SOLCO_ALLOWED_HOSTS` | — | Nomi host aggiuntivi ammessi nell'header `Host`, separati da virgola (es. `mio-pc.local,192.168.1.20`). Serve insieme a `SOLCO_HOST`. |
| `SOLCO_LMSTUDIO_URL` | `http://127.0.0.1:1234/v1` | Indirizzo dell'API di LM Studio. |
| `SOLCO_AI_MODEL` | — | Modello di LM Studio da preferire, se ce n'è più di uno caricato. |
| `SOLCO_OPENROUTER_KEY` | — | Chiave OpenRouter. Se impostata ha la precedenza su quella salvata e non viene mai scritta su disco. |
| `SOLCO_CONFIG_DIR` | vedi sotto | Cartella in cui salvare la chiave OpenRouter. |
| `SOLCO_FFMPEG` | cercato nel `PATH` | Percorso completo dell'eseguibile di ffmpeg. |
| `SOLCO_ANALISI_WORKER` | metà dei core, massimo 4 | Numero di processi paralleli per l'analisi audio. |

Esempio:

```bash
PORT=3800 SOLCO_FFMPEG=/opt/ffmpeg/bin/ffmpeg ./avvia-solco.sh
```

## Dove sta la chiave OpenRouter

La chiave inserita nelle impostazioni dell'app **non** viene salvata nella cartella
di Solco, ma nella cartella di configurazione dell'utente, in `credentials.json`
con permessi `0600`:

- Linux: `~/.config/solco/credentials.json` (o `$XDG_CONFIG_HOME/solco/`)
- macOS: `~/Library/Application Support/Solco/credentials.json`
- Windows: `%APPDATA%\Solco\credentials.json`

Con `SOLCO_CONFIG_DIR` si sceglie un'altra cartella. In alternativa si può passare
la chiave con `SOLCO_OPENROUTER_KEY`, senza salvarla da nessuna parte.
In `ai-config.json`, nella cartella dell'app, restano solo il provider e il modello
scelti. Le chiavi trovate lì dalle versioni precedenti vengono spostate al primo
avvio.

## File locali

Questi file vengono creati nella cartella dell'app e sono esclusi da git:
`library.json`, `playlists.json`, `stats.json`, `radio-solco.json`,
`album-overrides.json`, `ai-config.json`, `web-cache.json` e la cartella `cache/`
(indice dei metadati, copertine, risultati dell'analisi audio, modelli scaricati).

## Modelli Essentia e licenza

Al primo utilizzo dell'analisi audio Solco scarica da
<https://essentia.upf.edu/models> i modelli pre-addestrati (MusiCNN e le relative
teste di classificazione) e li salva in `cache/models/`. Questi modelli **non**
fanno parte del repository e sono distribuiti dal Music Technology Group
dell'Universitat Pompeu Fabra con licenza
[CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/): uso non
commerciale, con attribuzione, senza opere derivate. La licenza di Solco non si
estende ai modelli; per un uso commerciale servono accordi con l'UPF.

## Licenza

Il codice di Solco è distribuito con licenza [MIT](LICENSE), © 2026 Giuseppe Quero.
La licenza riguarda solo il codice di questo repository: i modelli Essentia scaricati
a runtime restano sotto CC BY-NC-ND 4.0 (vedi sopra).
