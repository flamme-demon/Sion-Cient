#!/usr/bin/env bash
# Build Android.
# NOTE : la voix dépend du moteur Rust (`native-voice`), qui n'est pas
# compilé ici (pas de libwebrtc pour Android — les patches webrtc-sys ne
# s'appliquent pas). La voix Android est donc inactive tant que le moteur
# n'y est pas porté.
set -euo pipefail

CARGO_TOML="src-tauri/Cargo.toml"

# Force rustup toolchain (Arch Linux a un rustc système sans target Android)
export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$HOME/.cargo/bin:$PATH"

# Désactive les features desktop natives le temps du build Android.
enable_android() {
    echo "[Sion] Mode Android..."
    sed -i 's/^default = \["native-voice"\]/default = []/' "$CARGO_TOML"
}

restore_desktop() {
    echo "[Sion] Mode Desktop..."
    sed -i 's/^default = \[\]/default = ["native-voice"]/' "$CARGO_TOML"
    echo "[Sion] Mise à jour Cargo.lock..."
    cd src-tauri && cargo update -p tauri --quiet 2>/dev/null || true; cd ..
}

trap restore_desktop EXIT
enable_android

echo "[Sion] Lancement build Android..."
if [ "${1:-}" = "dev" ]; then
    # Si Vite tourne déjà sur 5173, le tuer et laisser Tauri relancer le sien
    if lsof -ti :5173 >/dev/null 2>&1; then
        echo "[Sion] Vite actif sur :5173, on le tue pour le build"
        kill $(lsof -ti :5173) 2>/dev/null
        sleep 1
    fi
    bun run tauri android dev
elif [ "${1:-}" = "build" ]; then
    bun run tauri android build

    # Centralised installer collection — copy the signed APK to build-apps/
    PROJECT_DIR="$(pwd)"
    BUILD_APPS_DIR="$PROJECT_DIR/build-apps"
    mkdir -p "$BUILD_APPS_DIR"

    VERSION=$(grep -m1 '"version"' "$PROJECT_DIR/package.json" \
        | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    : "${VERSION:=0.0.0}"

    # Tauri places the signed release APK under src-tauri/gen/android/app/build/outputs/apk/
    APK_SRC=$(find "$PROJECT_DIR/src-tauri/gen/android/app/build/outputs/apk/universal/release" \
        -name "*.apk" 2>/dev/null | head -1)
    if [ -z "$APK_SRC" ]; then
        APK_SRC=$(find "$PROJECT_DIR/src-tauri/gen/android/app/build/outputs/apk" \
            -name "*-release*.apk" 2>/dev/null | head -1)
    fi

    if [ -n "$APK_SRC" ] && [ -f "$APK_SRC" ]; then
        APK_DEST="$BUILD_APPS_DIR/Sion_Client-${VERSION}.apk"
        cp -f "$APK_SRC" "$APK_DEST"
        SIZE=$(du -h "$APK_DEST" | cut -f1)
        echo ""
        echo "[Sion] APK copie: $APK_DEST ($SIZE)"
    else
        echo "[Sion] ATTENTION: APK release introuvable dans src-tauri/gen/android/app/build/outputs/apk/"
    fi
else
    echo "Usage: $0 [dev|build]"
    exit 1
fi
