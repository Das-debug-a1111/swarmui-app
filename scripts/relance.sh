#!/bin/bash
# Relance l'app : ferme l'instance de ce dossier (SIGKILL, car la garde Cmd+Q bloque SIGTERM) puis la rouvre en arrière-plan.
cd "$(dirname "$0")/.." || exit 1
pkill -9 -f "$PWD/node_modules/electron/dist/Electron.app" 2>/dev/null
sleep 1
nohup npm start >/dev/null 2>&1 &
disown
echo "Swarm-App relancée ($(grep -m1 '"version"' package.json | tr -d ' ,'))"
