#!/bin/bash
# Swap the minimal libcef.so (no proprietary codecs) for the STANDARD build's
# (with H.264/AAC) so <video> plays MP4 natively. The `cef` crate downloads the
# minimal distribution; we only fetch the standard libcef.so (~870 MB archive,
# once) and overwrite it in every cef build dir matching the current version.
#
# Version MUST match what cef-dll-sys downloads — read it from the build's
# archive.json (e.g. cef_binary_147.0.10+gd58e84d+chromium-147.0.7727.118).
set -e

# Keep in sync with the `cef` crate version in src-tauri/Cargo.toml.
CEF_BUILD="cef_binary_147.0.10+gd58e84d+chromium-147.0.7727.118_linux64"
CEF_URL="https://cef-builds.spotifycdn.com/${CEF_BUILD// /}.tar.bz2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION_TAG="147.0.10"

# All cef build dirs (debug + release) whose archive.json matches the version.
mapfile -t CEF_DIRS < <(find "$ROOT/src-tauri/target" -type f -path "*cef_linux_x86_64/archive.json" \
  -exec grep -l "$VERSION_TAG" {} \; 2>/dev/null | xargs -r -n1 dirname)

if [ ${#CEF_DIRS[@]} -eq 0 ]; then
    echo "❌ Aucun dossier CEF $VERSION_TAG trouvé. Lancez 'cargo build' d'abord."
    exit 1
fi

# Download + extract libcef.so once.
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT
echo "⬇️  Téléchargement du build CEF standard $VERSION_TAG (~870 Mo)..."
echo "   $CEF_URL"
# %2B-encode the '+' in the path.
ENC_URL="${CEF_URL//+/%2B}"
curl -L --progress-bar -o "$TMPDIR/cef_standard.tar.bz2" "$ENC_URL"
echo "📦 Extraction de libcef.so..."
tar -xjf "$TMPDIR/cef_standard.tar.bz2" -C "$TMPDIR" --wildcards "*/Release/libcef.so" --strip-components=2
if [ ! -f "$TMPDIR/libcef.so" ]; then
    echo "❌ libcef.so non trouvé dans l'archive standard"
    exit 1
fi

# Swap into each matching cef dir (backup the minimal once) + the run dirs.
for d in "${CEF_DIRS[@]}"; do
    [ -f "$d/libcef.so" ] || continue
    [ -f "$d/libcef.so.minimal.bak" ] || cp "$d/libcef.so" "$d/libcef.so.minimal.bak"
    cp "$TMPDIR/libcef.so" "$d/libcef.so"
    echo "   → $d/libcef.so"
done
for run in "$ROOT/src-tauri/target/debug/libcef.so" "$ROOT/src-tauri/target/release/libcef.so"; do
    [ -f "$run" ] && cp "$TMPDIR/libcef.so" "$run" && echo "   → $run"
done

echo "✅ libcef.so standard installé (codecs H.264/AAC). Relancez l'application."
