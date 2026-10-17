#!/bin/bash
# Avvio di Solco su macOS.
#
# Doppio clic dal Finder. La PRIMA volta, su questo Mac, va reso eseguibile:
#   chmod +x "Avvia Solco.command"
# (basta una volta sola, dal Terminale, nella cartella dell'app)

cd "$(dirname "$0")" || exit 1

PORT="${PORT:-3747}"
URL="http://localhost:$PORT"

attendi_tasto() {
  echo
  read -n 1 -s -r -p "Premi un tasto per chiudere."
  echo
}

# Avviato dal Finder, il PATH puo' non includere Node: aggiungo le posizioni tipiche
# di Homebrew (Apple Silicon e Intel).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js non risulta installato, oppure non e' nel PATH."
  echo
  echo "Installalo da https://nodejs.org"
  echo "oppure, se hai Homebrew:  brew install node"
  attendi_tasto
  exit 1
fi

# Solco usa fetch(), disponibile dalla 18.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "Serve Node.js 18 o superiore; qui c'e' la versione $(node -v 2>/dev/null)."
  echo "Aggiornalo da https://nodejs.org oppure con:  brew upgrade node"
  attendi_tasto
  exit 1
fi

if [ ! -f server.js ]; then
  echo "server.js non trovato in questa cartella:"
  echo "  $(pwd)"
  echo
  echo "Tieni il file .command insieme al resto dell'app."
  attendi_tasto
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Dipendenze mancanti: le installo (serve la rete, una volta sola)..."
  if ! npm install; then
    echo
    echo "Installazione delle dipendenze non riuscita."
    attendi_tasto
    exit 1
  fi
  echo
fi

# Apre il browser solo quando il server risponde davvero (attesa massima ~10 s).
# Se non c'e' modo di sondare la porta, ripiega su una breve attesa fissa.
porta_pronta() {
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1
  elif command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null --max-time 1 "$URL" >/dev/null 2>&1
  else
    return 2
  fi
}

(
  for _ in $(seq 1 50); do
    porta_pronta
    esito=$?
    if [ "$esito" -eq 0 ]; then
      open "$URL"
      exit 0
    fi
    if [ "$esito" -eq 2 ]; then
      sleep 2
      open "$URL"
      exit 0
    fi
    sleep 0.2
  done
) &

echo "Solco si sta avviando su $URL"
echo "Per fermarlo: Ctrl-C, oppure chiudi questa finestra."
echo

PORT="$PORT" node server.js

attendi_tasto
