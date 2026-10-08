#!/bin/sh
# Builds the editor and serves it at http://localhost:5179 (macOS, Linux).
# Web MIDI needs a served page; the fixed port keeps the browser's MIDI permission.
cd "$(dirname "$0")/.." || exit 1
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is needed: https://nodejs.org (or your distribution's nodejs + npm packages)."
  printf 'Press Enter to close. '; read -r _
  exit 1
fi
[ -d node_modules ] || npm install || exit 1
npm start
status=$?
if [ $status -ne 0 ]; then
  echo
  echo "Didn't start. If port 5179 is taken, the editor may already be running: open http://localhost:5179"
  printf 'Press Enter to close. '; read -r _
fi
exit $status
