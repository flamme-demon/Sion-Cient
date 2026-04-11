#!/bin/bash
# Sion Client — Create a GitHub Release and upload build artifacts
# Usage: ./build-scripts/create-release.sh [--draft]
#
# Reads version from package.json, creates a git tag, a GitHub release,
# and uploads all files from build-apps/.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build-apps"

# Read version
VERSION=$(grep -m1 '"version"' "$PROJECT_DIR/package.json" \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')

if [ -z "$VERSION" ]; then
    echo "ERREUR: Impossible de lire la version depuis package.json"
    exit 1
fi

TAG="v$VERSION"
DRAFT_FLAG=""
if [ "$1" = "--draft" ]; then
    DRAFT_FLAG="--draft"
fi

echo ""
echo "========================================"
echo "  Sion Client - Release $TAG"
echo "========================================"
echo ""

# Check gh CLI
if ! command -v gh &>/dev/null; then
    echo "ERREUR: GitHub CLI (gh) non installe."
    echo "  Installez-le: https://cli.github.com/"
    exit 1
fi

# Check build artifacts exist
if [ ! -d "$BUILD_DIR" ] || [ -z "$(ls -A "$BUILD_DIR" 2>/dev/null)" ]; then
    echo "ERREUR: Aucun fichier dans build-apps/"
    echo "  Lancez d'abord les builds (build-appimage.sh, build-windows.ps1)"
    exit 1
fi

echo "Fichiers a uploader:"
ls -lh "$BUILD_DIR/"
echo ""

# Create tag if it doesn't exist
if git rev-parse "$TAG" &>/dev/null; then
    echo "Tag $TAG existe deja."
else
    echo "Creation du tag $TAG..."
    git tag -a "$TAG" -m "Release $TAG"
    git push origin "$TAG"
fi

# Create release
echo "Creation de la release GitHub..."
gh release create "$TAG" \
    --title "Sion Client $TAG" \
    --notes "## Sion Client $TAG

### Téléchargement
- **Linux**: AppImage (portable, double-cliquer pour lancer)
- **Windows**: Installeur NSIS ou MSI

### Nouveautés
Voir les commits depuis la dernière release pour le détail des changements." \
    $DRAFT_FLAG \
    "$BUILD_DIR"/*

echo ""
echo "========================================"
echo "  Release $TAG creee !"
echo "  https://github.com/flamme-demon/Sion-Cient/releases/tag/$TAG"
echo "========================================"
echo ""
