#!/bin/bash
# Avvio di Solco su Linux.
#
# Dal terminale, nella cartella dell'app:
#   chmod +x avvia-solco.sh   (la prima volta soltanto)
#   ./avvia-solco.sh
#
# Per aggiungere Solco al menu delle applicazioni (con i percorsi di questa cartella):
#   ./avvia-solco.sh --installa

cd "$(dirname "$0")" || exit 1

# Genera il lanciatore dal modello Solco.desktop sostituendo @SOLCO_DIR@ con la
# cartella attuale. Se l'app viene spostata, basta rilanciare --installa.
installa_lanciatore() {
  local dir dest stringa comando riga
  dir="$(pwd)"
  dest="${XDG_DATA_HOME:-$HOME/.local/share}/applications/solco.desktop"

  # Nei valori del file .desktop la barra rovesciata va raddoppiata; dentro Exec,
  # inoltre, il percorso sta tra virgolette, dove " ` $ \ vanno protetti e % raddoppiato.
  stringa="${dir//\\/\\\\}"
  comando="${dir//\\/\\\\}"
  comando="${comando//\"/\\\"}"
  comando="${comando//\`/\\\`}"
  comando="${comando//\$/\\\$}"
  comando="${comando//\\/\\\\}"
  comando="${comando//%/%%}"

  mkdir -p "$(dirname "$dest")" || return 1
  {
    while IFS= read -r riga || [ -n "$riga" ]; do
      case "$riga" in
        '#'*) continue ;;
        Exec=*) printf '%s\n' "${riga//@SOLCO_DIR@/"$comando"}" ;;
        *) printf '%s\n' "${riga//@SOLCO_DIR@/"$stringa"}" ;;
      esac
    done < Solco.desktop
  } > "$dest" || return 1
  chmod +x "$dest"
  command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "$(dirname "$dest")" >/dev/null 2>&1
  echo "Lanciatore installato in $dest"
  echo "Solco ora compare nel menu delle applicazioni."
}

if [ "$1" = "--installa" ]; then
  installa_lanciatore
  exit $?
fi

PORT="${PORT:-3747}"
URL="http://localhost:$PORT"

attendi_tasto() {
  echo
  read -n 1 -s -r -p "Premi un tasto per chiudere."
  echo
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js non risulta installato, oppure non e' nel PATH."
  echo
  echo "Installalo dal gestore pacchetti della tua distribuzione"
  echo "(es. apt install nodejs npm, dnf install nodejs, pacman -S nodejs npm)"
  echo "oppure da https://nodejs.org"
  attendi_tasto
  exit 1
fi

# Solco usa fetch(), disponibile dalla 18.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "Serve Node.js 18 o superiore; qui c'e' la versione $(node -v 2>/dev/null)."
  echo "Aggiornalo dal gestore pacchetti della tua distribuzione o da https://nodejs.org"
  attendi_tasto
  exit 1
fi

if [ ! -f server.js ]; then
  echo "server.js non trovato in questa cartella:"
  echo "  $(pwd)"
  echo
  echo "Tieni questo script insieme al resto dell'app."
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

# Apre il browser predefinito solo quando il server risponde davvero
# (attesa massima ~10 s). Se non si trova alcun modo per aprirlo automaticamente,
# lascia semplicemente l'indirizzo a schermo.
apri_browser() {
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 &
  elif command -v gio >/dev/null 2>&1; then
    gio open "$URL" >/dev/null 2>&1 &
  elif command -v gnome-open >/dev/null 2>&1; then
    gnome-open "$URL" >/dev/null 2>&1 &
  else
    echo "Apri manualmente $URL nel browser."
  fi
}

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
      apri_browser
      exit 0
    fi
    if [ "$esito" -eq 2 ]; then
      sleep 2
      apri_browser
      exit 0
    fi
    sleep 0.2
  done
) &

echo "Solco si sta avviando su $URL"
echo "Per fermarlo: Ctrl-C, oppure chiudi questo terminale."
echo

PORT="$PORT" node server.js

attendi_tasto
