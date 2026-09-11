#!/bin/bash
# Lancement dev : fenêtre WRY (WebKitGTK) + voix Rust, seul moteur vocal.
# - La webview n'embarque aucun LiveKit JS ; `native-voice` est une feature
#   par défaut.
# - Salon chiffré couvert par le pont E2EE MatrixRTC → Rust.
#
# Usage: ./build-scripts/run-native.sh [-- <args cargo>]
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

# Serveur Vite en arrière-plan
bun run dev &
VITE_PID=$!

echo "⏳ Démarrage du serveur Vite..."
while ! curl -s http://localhost:5173 > /dev/null 2>&1; do
    sleep 0.3
done
echo "✅ Serveur Vite prêt"

cleanup() {
    kill "$VITE_PID" 2>/dev/null
    wait "$VITE_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# Application avec la fenêtre WRY + voix native (feature par défaut).
# RUST_BACKTRACE=1 : la panique tokio "Cannot start a runtime from within a
# runtime" tue l'app sans stack sinon — intraçable (crash du 08/09 18h51).
cd "$PROJECT_DIR/src-tauri"
RUST_BACKTRACE=1 cargo run -j4 "$@"
