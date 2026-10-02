#!/bin/bash
# Récupère le binaire ffmpeg à embarquer dans le paquet.
#
# Sion en a besoin pour lire les vidéos du fil, en extraire l'affiche et
# convertir celles qui dépassent la limite d'envoi. Jusqu'ici on comptait sur
# celui du système, ou sur un téléchargement au premier usage — ce qui laisse
# sans rien un utilisateur hors ligne, et suppose qu'il comprenne pourquoi une
# vidéo ne s'ouvre pas.
#
# Le binaire n'est PAS versionné : il pèse 143 Mo et n'a rien à faire dans
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

# Build BtbN, LGPL, la même famille que sous Windows. Il remplace celui de
# johnvansickle (02/10), qui n'encodait l'AV1 qu'avec libaom, sur le
# processeur : 13 minutes pour un reel de trois minutes en 1080x1920. Celui-ci
# porte SVT-AV1 (60 s) et les encodeurs des cartes graphiques — VAAPI,
# Vulkan, NVENC, QSV, AMF (12 s) — et décode toujours l'AV1 par dav1d. Il ne
# dépend que de la glibc. Le paquet grossit de 23 Mo une fois compressé.
# LGPL : ni x264 ni x265 (GPL) ; OpenH264 sert de repli H.264.
ARCHIVE="$CACHE/ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz"
URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz"

if [ ! -f "$ARCHIVE" ]; then
    echo "Téléchargement de ffmpeg…"
    curl -fsSL --retry 3 -o "$ARCHIVE.partiel" "$URL"
    mv "$ARCHIVE.partiel" "$ARCHIVE"
fi

# Seul `ffmpeg` nous sert : ni ffprobe, ni les pages de manuel.
tar -xJf "$ARCHIVE" --wildcards --strip-components=2 -C "$DEST" "*/bin/ffmpeg"
chmod +x "$DEST/ffmpeg"

TAILLE=$(du -h "$DEST/ffmpeg" | cut -f1)
echo "ffmpeg embarqué : $DEST/ffmpeg ($TAILLE)"
