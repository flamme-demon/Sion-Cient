#!/bin/bash
# Script de lancement pour Sion Client avec CEF
# Nécessite que les bibliothèques CEF soient copiées dans target/debug/

set -e

cd "$(dirname "$0")/src-tauri"

# Vérifier que les bibliothèques CEF sont présentes
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

# Lancer l'application
exec cargo run "$@"