#!/bin/bash
# Lancement dev avec voix native (chantier suppression CEF).
# - Fenêtre : CEF par défaut (comme run-cef.sh) — la voix ne passe plus par
#   Chromium, mais l'UI reste identique pour isoler les variables.
# - Bascule voix : Réglages → Voix → "Moteur voix" → "Natif Rust".
# - Salon non-chiffré d'abord : le pont E2EE natif arrive à l'étape suivante.
#
# Usage: ./build-scripts/run-native.sh [-- <args cargo>]
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR/src-tauri"

# Libs CEF pour la fenêtre (identique à run-cef.sh)
if [ ! -f "target/debug/libcef.so" ]; then
    echo "⚠️  Bibliothèques CEF non trouvées. Copie en cours..."
    CEF_DIR=$(find target/debug/build -name "cef_linux_x86_64" -type d | head -1)
    if [ -z "$CEF_DIR" ]; then
        echo "❌ Impossible de trouver les binaires CEF. Lancez 'cargo build' d'abord."
        exit 1
    fi
    cp -n "$CEF_DIR/libcef.so" target/debug/ 2>/dev/null || true
    cp -n "$CEF_DIR/libEGL.so" target/debug/ 2>/dev/null || true
    cp -n "$CEF_DIR/libGLESv2.so" target/debug/ 2>/dev/null || true
    cp -n "$CEF_DIR/libvulkan.so.1" target/debug/ 2>/dev/null || true
    cp -n "$CEF_DIR/libvk_swiftshader.so" target/debug/ 2>/dev/null || true
    cp -rn "$CEF_DIR/locales" target/debug/ 2>/dev/null || true
    cp -n "$CEF_DIR/chrome_100_percent.pak" target/debug/ 2>/dev/null || true
    cp -n "$CEF_DIR/chrome_200_percent.pak" target/debug/ 2>/dev/null || true
    cp -n "$CEF_DIR/resources.pak" target/debug/ 2>/dev/null || true
    cp -n "$CEF_DIR/icudtl.dat" target/debug/ 2>/dev/null || true
    cp -n "$CEF_DIR/v8_context_snapshot.bin" target/debug/ 2>/dev/null || true
    echo "✅ Bibliothèques CEF copiées"
fi

# Serveur Vite en arrière-plan
cd "$PROJECT_DIR"
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

# Application avec CEF (fenêtre) + voix native (feature)
cd "$PROJECT_DIR/src-tauri"
cargo run -j4 --features native-voice "$@"
