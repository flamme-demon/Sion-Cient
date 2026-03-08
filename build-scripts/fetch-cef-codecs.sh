#!/bin/bash
# Télécharge le build CEF standard (avec codecs H.264/AAC) et remplace libcef.so
# Le build "minimal" par défaut n'inclut pas les codecs propriétaires.
# Ce script ne télécharge que libcef.so du build standard (~870 Mo compressé, une seule fois).

set -e

CEF_VERSION="144.0.7"
CEF_BUILD="cef_binary_${CEF_VERSION}+g03bd3db+chromium-144.0.7559.97_linux64"
CEF_URL="https://cef-builds.spotifycdn.com/${CEF_BUILD}.tar.bz2"
CEF_DIR="$(dirname "$0")/../src-tauri/target/debug/build/cef-dll-sys-*/out/cef_linux_x86_64"

# Résoudre le glob
CEF_DIR_RESOLVED=$(echo $CEF_DIR)
if [ ! -d "$CEF_DIR_RESOLVED" ]; then
    echo "❌ Répertoire CEF non trouvé. Lancez 'cargo build' d'abord."
    exit 1
fi

LIBCEF="$CEF_DIR_RESOLVED/libcef.so"
LIBCEF_BACKUP="$CEF_DIR_RESOLVED/libcef.so.minimal.bak"

if [ -f "$LIBCEF_BACKUP" ]; then
    echo "✅ libcef.so standard déjà installé (backup minimal existe)"
    exit 0
fi

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "⬇️  Téléchargement du build CEF standard (~870 Mo)..."
echo "   URL: $CEF_URL"
curl -L --progress-bar -o "$TMPDIR/cef_standard.tar.bz2" "$CEF_URL"

echo "📦 Extraction de libcef.so..."
# Extraire seulement libcef.so du tarball
tar -xjf "$TMPDIR/cef_standard.tar.bz2" -C "$TMPDIR" --wildcards "*/Release/libcef.so" --strip-components=2

if [ ! -f "$TMPDIR/libcef.so" ]; then
    echo "❌ libcef.so non trouvé dans l'archive standard"
    exit 1
fi

echo "🔄 Remplacement de libcef.so..."
cp "$LIBCEF" "$LIBCEF_BACKUP"
cp "$TMPDIR/libcef.so" "$LIBCEF"

# Copier aussi dans target/debug/ si présent
TARGET_DEBUG="$(dirname "$0")/../src-tauri/target/debug"
if [ -f "$TARGET_DEBUG/libcef.so" ]; then
    cp "$TMPDIR/libcef.so" "$TARGET_DEBUG/libcef.so"
    echo "   → Copié aussi dans target/debug/"
fi

echo "✅ libcef.so standard installé (codecs H.264/AAC activés)"
echo "   Backup minimal: $LIBCEF_BACKUP"
echo "   Relancez l'application pour appliquer."
