#!/usr/bin/env bash
# Build Android — désactive temporairement le CEF (incompatible Android)
set -euo pipefail

CARGO_TOML="src-tauri/Cargo.toml"
CARGO_LOCK="src-tauri/Cargo.lock"
BACKUP="src-tauri/Cargo.toml.desktop"

# Force rustup toolchain (Arch Linux a un rustc système sans target Android)
export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$HOME/.cargo/bin:$PATH"

# S'assurer que Cargo.toml est propre (version git, pas modifiée par un build desktop)
echo "[Sion] Restauration Cargo.toml depuis git..."
git checkout "$CARGO_TOML" "$CARGO_LOCK" 2>/dev/null || true

echo "[Sion] Sauvegarde Cargo.toml desktop..."
cp "$CARGO_TOML" "$BACKUP"

echo "[Sion] Désactivation CEF pour Android..."
# Commenter le patch crates-io et la feature CEF
sed -i 's/^default = \["cef"\]/default = []/' "$CARGO_TOML"
sed -i 's/^cef = \[.*\]/# cef = []/' "$CARGO_TOML"
sed -i 's/^tauri-runtime-cef/# tauri-runtime-cef/' "$CARGO_TOML"
sed -i 's/^\[patch\.crates-io\]/# [patch.crates-io]/' "$CARGO_TOML"
sed -i '/^# \[patch\.crates-io\]/,$ { /^[^#]/ s/^/# / }' "$CARGO_TOML"

restore() {
    echo "[Sion] Restauration Cargo.toml desktop..."
    mv "$BACKUP" "$CARGO_TOML"
}
trap restore EXIT

echo "[Sion] Lancement build Android..."
if [ "${1:-}" = "dev" ]; then
    bun run tauri android dev
elif [ "${1:-}" = "build" ]; then
    bun run tauri android build
else
    echo "Usage: $0 [dev|build]"
    exit 1
fi
