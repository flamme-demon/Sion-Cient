#!/bin/bash
# Sion Client — Script d'installation Linux (Arch/Manjaro)
# Usage: ./install-linux.sh [--uninstall]

set -e

APP_NAME="sion-client"
INSTALL_DIR="/opt/sion-client"
BIN_LINK="/usr/local/bin/sion-client"
DESKTOP_FILE="/usr/share/applications/sion-client.desktop"
ICON_FILE="/usr/share/icons/hicolor/128x128/apps/sion-client.png"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$SCRIPT_DIR/src-tauri/target/release"
CEF_DIR=$(find "$RELEASE_DIR/build" -name "cef_linux_x86_64" -type d 2>/dev/null | head -1)

# --- Uninstall ---
if [ "$1" = "--uninstall" ]; then
    echo "Suppression de Sion Client..."
    sudo rm -rf "$INSTALL_DIR"
    sudo rm -f "$BIN_LINK"
    sudo rm -f "$DESKTOP_FILE"
    sudo rm -f "$ICON_FILE"
    echo "Sion Client a ete desinstalle."
    exit 0
fi

# --- Build ---
echo "Build du frontend..."
(cd "$SCRIPT_DIR" && bun run build)

echo "Compilation Rust + CEF (peut prendre plusieurs minutes)..."
(cd "$SCRIPT_DIR/src-tauri" && cargo build --release)

# Refresh CEF_DIR after build
CEF_DIR=$(find "$RELEASE_DIR/build" -name "cef_linux_x86_64" -type d 2>/dev/null | head -1)

# --- Checks ---
if [ ! -f "$RELEASE_DIR/$APP_NAME" ]; then
    echo "Binaire non trouve: $RELEASE_DIR/$APP_NAME"
    echo "Le build a echoue."
    exit 1
fi

if [ -z "$CEF_DIR" ]; then
    echo "Binaires CEF non trouves dans $RELEASE_DIR/build/"
    echo "Le build a echoue."
    exit 1
fi

echo "Installation de Sion Client dans $INSTALL_DIR..."

# --- Install ---
sudo mkdir -p "$INSTALL_DIR"

# Binaire
sudo cp "$RELEASE_DIR/$APP_NAME" "$INSTALL_DIR/"
sudo chmod +x "$INSTALL_DIR/$APP_NAME"

# Libs CEF
echo "Copie des bibliotheques CEF (~1.6 GB)..."
for f in libcef.so libEGL.so libGLESv2.so libvulkan.so.1 libvk_swiftshader.so \
         chrome_100_percent.pak chrome_200_percent.pak resources.pak \
         icudtl.dat v8_context_snapshot.bin vk_swiftshader_icd.json; do
    [ -f "$CEF_DIR/$f" ] && sudo cp "$CEF_DIR/$f" "$INSTALL_DIR/"
done
sudo cp -r "$CEF_DIR/locales" "$INSTALL_DIR/"

# Script de lancement
sudo tee "$INSTALL_DIR/launch.sh" > /dev/null << 'LAUNCH'
#!/bin/bash
cd /opt/sion-client
export LD_LIBRARY_PATH="/opt/sion-client:$LD_LIBRARY_PATH"
exec ./sion-client "$@"
LAUNCH
sudo chmod +x "$INSTALL_DIR/launch.sh"

# Lien symbolique
sudo ln -sf "$INSTALL_DIR/launch.sh" "$BIN_LINK"

# Icone
sudo mkdir -p "$(dirname "$ICON_FILE")"
sudo cp "$SCRIPT_DIR/src-tauri/icons/128x128.png" "$ICON_FILE"

# Fichier .desktop
sudo tee "$DESKTOP_FILE" > /dev/null << 'DESKTOP'
[Desktop Entry]
Name=Sion Client
Comment=Voice and text client (Matrix + LiveKit)
Exec=/opt/sion-client/launch.sh
Icon=sion-client
Type=Application
Categories=Network;Chat;AudioVideo;
Terminal=false
StartupWMClass=sion-client
DESKTOP
sudo chmod 644 "$DESKTOP_FILE"

# Refresh desktop database
command -v update-desktop-database &>/dev/null && sudo update-desktop-database /usr/share/applications/ 2>/dev/null || true

echo ""
echo "Sion Client installe avec succes !"
echo "  Lancer: sion-client"
echo "  Desinstaller: $0 --uninstall"
