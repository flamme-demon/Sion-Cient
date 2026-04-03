#!/usr/bin/env bash
# Build Android — désactive temporairement le CEF (incompatible Android)
set -euo pipefail

CARGO_TOML="src-tauri/Cargo.toml"

# Force rustup toolchain (Arch Linux a un rustc système sans target Android)
export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$HOME/.cargo/bin:$PATH"

enable_android() {
    echo "[Sion] Mode Android..."
    sed -i 's/^default = \["cef"\]/default = []/' "$CARGO_TOML"
    sed -i 's/^cef = \[/# cef = [/' "$CARGO_TOML"
    sed -i 's/^tauri-runtime-cef/# tauri-runtime-cef/' "$CARGO_TOML"
    sed -i 's/^cef = { version/# cef = { version/' "$CARGO_TOML"
    sed -i 's/^\[patch\.crates-io\]/# [patch.crates-io]/' "$CARGO_TOML"
    sed -i '/^# \[patch\.crates-io\]/,$ { /^[^#]/ s/^/# / }' "$CARGO_TOML"
}

restore_desktop() {
    echo "[Sion] Mode Desktop..."
    sed -i 's/^default = \[\]/default = ["cef"]/' "$CARGO_TOML"
    sed -i 's/^# cef = \[/cef = [/' "$CARGO_TOML"
    sed -i 's/^# tauri-runtime-cef/tauri-runtime-cef/' "$CARGO_TOML"
    sed -i 's/^# cef = { version/cef = { version/' "$CARGO_TOML"
    sed -i 's/^# \[patch\.crates-io\]/[patch.crates-io]/' "$CARGO_TOML"
    sed -i '/^\[patch\.crates-io\]/,$ { s/^# // }' "$CARGO_TOML"
    echo "[Sion] Mise à jour Cargo.lock pour CEF..."
    cd src-tauri && cargo update -p tauri --quiet 2>/dev/null; cd ..
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
else
    echo "Usage: $0 [dev|build]"
    exit 1
fi
