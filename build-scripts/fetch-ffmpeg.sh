#!/bin/bash
# Récupère le binaire ffmpeg à embarquer dans le paquet.
#
# Sion en a besoin pour lire les vidéos du fil, en extraire l'affiche et
# convertir celles qui dépassent la limite d'envoi. Jusqu'ici on comptait sur
# celui du système, ou sur un téléchargement au premier usage — ce qui laisse
# sans rien un utilisateur hors ligne, et suppose qu'il comprenne pourquoi une
# vidéo ne s'ouvre pas.
#
# Le binaire n'est PAS versionné : il pèse 76 Mo et n'a rien à faire dans
# l'historique. Ce script le télécharge au moment de la construction, et le
# cache d'un build à l'autre.
#
# Usage : ./build-scripts/fetch-ffmpeg.sh [destination]
#         (par défaut src-tauri/resources/)
set -euo pipefail

PROJET="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$PROJET/src-tauri/resources}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/sion-build"

mkdir -p "$DEST" "$CACHE"

if [ -x "$DEST/ffmpeg" ]; then
    echo "ffmpeg déjà en place : $DEST/ffmpeg"
    exit 0
fi

# Build statique : aucune bibliothèque à traîner, il tourne sur n'importe
# quelle distribution. Le paquet grossit de 22 Mo une fois compressé par
# squashfs, mesuré le 21/09.
ARCHIVE="$CACHE/ffmpeg-release-amd64-static.tar.xz"
URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"

if [ ! -f "$ARCHIVE" ]; then
    echo "Téléchargement de ffmpeg…"
    curl -fsSL --retry 3 -o "$ARCHIVE.partiel" "$URL"
    mv "$ARCHIVE.partiel" "$ARCHIVE"
fi

# Seul `ffmpeg` nous sert : ni ffprobe, ni les pages de manuel.
tar -xJf "$ARCHIVE" --wildcards --strip-components=1 -C "$DEST" "*/ffmpeg"
chmod +x "$DEST/ffmpeg"

TAILLE=$(du -h "$DEST/ffmpeg" | cut -f1)
echo "ffmpeg embarqué : $DEST/ffmpeg ($TAILLE)"
