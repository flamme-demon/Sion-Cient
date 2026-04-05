#!/bin/bash
# Sion Client — Build AppImage pour Linux
# Usage: ./build-scripts/build-appimage.sh
#
# Produit un .AppImage autonome avec les libs CEF incluses.
# Le bundler Tauri CEF ne supporte pas l'AppImage, donc on le construit
# manuellement avec linuxdeploy.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_DIR="$PROJECT_DIR/src-tauri/target/release"
APPDIR="$RELEASE_DIR/SionClient.AppDir"
OUTPUT_DIR="$PROJECT_DIR/dist-appimage"
APP_NAME="sion-client"

echo ""
echo "========================================"
echo "  Sion Client - Build AppImage"
echo "========================================"
echo ""

# --- 1. Dependencies check ---
for cmd in bun cargo; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERREUR: $cmd non trouve. Installez-le d'abord."
        exit 1
    fi
done

# --- 2. Full Tauri build (frontend + Rust) ---
echo "[1/5] Build complet via Tauri (frontend + Rust + CEF)..."
(cd "$PROJECT_DIR" && bun run tauri build 2>&1 || true)

# --- 4. Find CEF libs ---
echo "[3/5] Recherche des libs CEF..."
CEF_SRC=$(find "$RELEASE_DIR/build" -name "cef_linux_x86_64" -type d 2>/dev/null | head -1)

if [ -z "$CEF_SRC" ]; then
    echo "ERREUR: Libs CEF non trouvees dans target/release/build/"
    exit 1
fi

echo "  CEF trouve: $CEF_SRC"

# --- 5. Download AppImage tools ---
echo "[4/5] Verification des outils AppImage..."

TOOLS_DIR="$RELEASE_DIR/appimage-tools"
mkdir -p "$TOOLS_DIR"

# linuxdeploy
if [ ! -f "$TOOLS_DIR/linuxdeploy-x86_64.AppImage" ]; then
    echo "  Telechargement de linuxdeploy..."
    curl -L -o "$TOOLS_DIR/linuxdeploy-x86_64.AppImage" \
        "https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage"
    chmod +x "$TOOLS_DIR/linuxdeploy-x86_64.AppImage"
fi

# appimagetool (for manual AppDir → AppImage)
if [ ! -f "$TOOLS_DIR/appimagetool-x86_64.AppImage" ]; then
    echo "  Telechargement de appimagetool..."
    curl -L -o "$TOOLS_DIR/appimagetool-x86_64.AppImage" \
        "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x "$TOOLS_DIR/appimagetool-x86_64.AppImage"
fi

APPIMAGETOOL="$TOOLS_DIR/appimagetool-x86_64.AppImage"

# --- 6. Build AppDir manually ---
echo "[5/5] Construction de l'AppImage..."

# Clean previous AppDir
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/lib/sion-client/locales"
mkdir -p "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/usr/share/icons/hicolor/128x128/apps"

# Copy binary
cp "$RELEASE_DIR/$APP_NAME" "$APPDIR/usr/bin/$APP_NAME"

# Copy CEF libs next to binary (CEF needs them in the same dir or LD_LIBRARY_PATH)
CEF_FILES=(
    libcef.so libEGL.so libGLESv2.so libvulkan.so.1 libvk_swiftshader.so
    chrome_100_percent.pak chrome_200_percent.pak resources.pak
    icudtl.dat v8_context_snapshot.bin vk_swiftshader_icd.json
)

count=0
for f in "${CEF_FILES[@]}"; do
    if [ -f "$CEF_SRC/$f" ]; then
        cp "$CEF_SRC/$f" "$APPDIR/usr/lib/sion-client/"
        count=$((count + 1))
    fi
done

if [ -d "$CEF_SRC/locales" ]; then
    cp "$CEF_SRC/locales/"* "$APPDIR/usr/lib/sion-client/locales/"
fi

echo "  $count fichiers CEF copies"

# Copy icon
cp "$PROJECT_DIR/src-tauri/icons/128x128.png" "$APPDIR/usr/share/icons/hicolor/128x128/apps/$APP_NAME.png"
cp "$PROJECT_DIR/src-tauri/icons/128x128.png" "$APPDIR/$APP_NAME.png"

# Create .desktop file
cat > "$APPDIR/$APP_NAME.desktop" <<DESKTOP
[Desktop Entry]
Name=Sion Client
Exec=sion-client
Icon=sion-client
Type=Application
Categories=Network;Chat;
Comment=Voice and text client built on Matrix
DESKTOP

cp "$APPDIR/$APP_NAME.desktop" "$APPDIR/usr/share/applications/"

# Create AppRun script — sets LD_LIBRARY_PATH so CEF libs are found
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/bash
SELF_DIR="$(dirname "$(readlink -f "$0")")"
export LD_LIBRARY_PATH="$SELF_DIR/usr/lib/sion-client:${LD_LIBRARY_PATH}"
exec "$SELF_DIR/usr/bin/sion-client" "$@"
APPRUN

chmod +x "$APPDIR/AppRun"

# Build the AppImage
mkdir -p "$OUTPUT_DIR"
ARCH=x86_64 "$APPIMAGETOOL" "$APPDIR" "$OUTPUT_DIR/Sion_Client-x86_64.AppImage"

# --- Result ---
echo ""
echo "========================================"

APPIMAGE="$OUTPUT_DIR/Sion_Client-x86_64.AppImage"

if [ -f "$APPIMAGE" ]; then
    SIZE=$(du -h "$APPIMAGE" | cut -f1)
    echo "  Build reussi !"
    echo "  AppImage: $APPIMAGE ($SIZE)"
    echo ""
    echo "  Pour lancer: chmod +x \"$APPIMAGE\" && \"$APPIMAGE\""
else
    echo "  ERREUR: AppImage non trouvee."
    echo "  Verifiez les logs ci-dessus."
fi

echo "========================================"
echo ""
