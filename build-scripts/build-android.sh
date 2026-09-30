#!/usr/bin/env bash
# Build Android (docs/plan-android-2.1.md).
#
# Mêmes features que sur ordinateur : moteur Matrix Rust et voix Rust
# (libwebrtc précompilé pour Android, classes Java dans libwebrtc.jar). Plus
# aucune retouche de Cargo.toml : ce qui est propre au bureau est exclu par
# `cfg(not(target_os = "android"))` dans le code.
#
#   debug : APK de dev (com.sion.client.dev, installable à côté de la version
#           publiée), installé et lancé si un téléphone est branché ;
#   build : APK de publication (signé si gen/android/keystore.properties existe) ;
#   dev   : `tauri android dev` (rechargement à chaud depuis Vite, même réseau).
set -euo pipefail
# Un arrêt sur erreur dit où : sans cela, `set -e` quittait en silence (CI).
trap 'echo "[Sion] échec ligne $LINENO : $BASH_COMMAND" >&2' ERR

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# rustc de rustup (cibles Android installées), pas celui du système.
export PATH="$HOME/.cargo/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.2.12479018}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$NDK_HOME}"
# Gradle 8 / AGP 8 : JDK 17.
if [ -z "${JAVA_HOME:-}" ] && [ -d /usr/lib/jvm/java-17-openjdk ]; then
    export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
fi

APP_DIR="src-tauri/gen/android/app"
APPLICATION_ID="com.sion.client"

# ── libwebrtc.jar ─────────────────────────────────────────────────────────────
# Même version que la libwebrtc liée par webrtc-sys : son tag vient de la
# crate `webrtc-sys-build` du Cargo.lock. Pris dans l'archive déjà téléchargée
# par un build précédent, sinon téléchargé.
preparer_libwebrtc_jar() {
    local version tag jar cache
    cargo fetch --manifest-path src-tauri/Cargo.toml --quiet
    version=$(grep -A1 '^name = "webrtc-sys-build"' src-tauri/Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p')
    tag=$(grep -h 'pub const WEBRTC_TAG' "$HOME"/.cargo/registry/src/*/webrtc-sys-build-"$version"/src/lib.rs \
        | head -1 | sed -E 's/.*"(.*)".*/\1/')
    [ -n "$tag" ] || { echo "[Sion] tag libwebrtc introuvable (webrtc-sys-build $version)"; exit 1; }

    # `target` n'existe pas encore sur une machine neuve (CI sans cache) :
    # `find` y échoue, ce qui ne doit pas arrêter le script.
    jar=$(find src-tauri/target -path "*/livekit/android-arm64-release-$tag/android-arm64-release/libwebrtc.jar" \
        2>/dev/null | head -1 || true)
    if [ -z "$jar" ]; then
        cache="$HOME/.cache/sion/libwebrtc-android-$tag"
        jar="$cache/libwebrtc.jar"
        if [ ! -f "$jar" ]; then
            echo "[Sion] Téléchargement de libwebrtc Android ($tag)…"
            mkdir -p "$cache"
            curl -fL "https://github.com/livekit/rust-sdks/releases/download/$tag/webrtc-android-arm64-release.zip" \
                -o "$cache/webrtc.zip"
            unzip -o -j "$cache/webrtc.zip" '*/libwebrtc.jar' -d "$cache"
            rm -f "$cache/webrtc.zip"
        fi
    fi
    mkdir -p "$APP_DIR/libs"
    cp -f "$jar" "$APP_DIR/libs/libwebrtc.jar"
    echo "[Sion] libwebrtc.jar ($tag) prêt"
}

preparer_libwebrtc_jar

# ── versionCode ───────────────────────────────────────────────────────────────
# Tauri calcule majeur×1 000 000 + mineur×1 000 + patch et ignore la
# pré-version : toutes les bêtas d'une version auraient le même code et ne
# s'installeraient pas l'une sur l'autre. Ici : majeur×10 000 000 +
# mineur×100 000 + patch×1 000 + rang de la pré-version (alpha.N → N,
# beta.N → 100+N, rc.N → 500+N, finale → 999). 2.1.0-beta.1 → 20100101,
# 2.1.0 → 20100999 ; toujours au-dessus des 1.x (1 000 000).
version_code() {
    local version=$1 base pre rang ma mi pa
    base=${version%%-*}
    pre=${version#"$base"}
    IFS=. read -r ma mi pa <<<"$base"
    case "$pre" in
        "")         rang=999 ;;
        -alpha.*)   rang=${pre#-alpha.} ;;
        -beta.*)    rang=$((100 + ${pre#-beta.})) ;;
        -rc.*)      rang=$((500 + ${pre#-rc.})) ;;
        *)          echo "[Sion] pré-version inconnue : $version" >&2; exit 1 ;;
    esac
    echo $((ma * 10000000 + mi * 100000 + pa * 1000 + rang))
}
VERSION=$(sed -n 's/^  "version": "\(.*\)",/\1/p' package.json)
VERSION_CODE=$(version_code "$VERSION")
CONFIG_ANDROID="{\"bundle\":{\"android\":{\"versionCode\":$VERSION_CODE}}}"
echo "[Sion] $VERSION → versionCode $VERSION_CODE"

case "${1:-}" in
    debug)
        # Sans les informations de débogage complètes, l'APK de dev passait
        # 1,3 Go ; les numéros de ligne suffisent aux traces de plantage.
        CARGO_PROFILE_DEV_DEBUG=line-tables-only \
            bun run tauri android build --debug --apk --target aarch64 --config "$CONFIG_ANDROID"
        APK=$(find "$APP_DIR/build/outputs/apk" -name "*debug*.apk" -newer "$APP_DIR/libs/libwebrtc.jar" | head -1)
        [ -n "$APK" ] || { echo "[Sion] APK de dev introuvable"; exit 1; }
        echo "[Sion] APK de dev : $APK ($(du -h "$APK" | cut -f1))"
        # Le téléphone branché en USB (ANDROID_SERIAL, sinon le premier appareil
        # USB) — jamais un appareil réseau (TV…) apparu dans adb entre-temps.
        SERIAL=${ANDROID_SERIAL:-$(adb devices | awk 'NR > 1 && $2 == "device" && $1 !~ /:/ { print $1; exit }')}
        if [ -n "$SERIAL" ]; then
            adb -s "$SERIAL" install -r "$APK"
            adb -s "$SERIAL" shell am start -n "$APPLICATION_ID.dev/$APPLICATION_ID.MainActivity"
        fi
        ;;
    build)
        bun run tauri android build --apk --target aarch64 --config "$CONFIG_ANDROID"
        BUILD_APPS_DIR="$PROJECT_DIR/build-apps"
        mkdir -p "$BUILD_APPS_DIR"
        APK=$(find "$APP_DIR/build/outputs/apk" -name "*release*.apk" | head -1)
        if [ -n "$APK" ]; then
            cp -f "$APK" "$BUILD_APPS_DIR/Sion_Client-${VERSION}-arm64.apk"
            echo "[Sion] APK : $BUILD_APPS_DIR/Sion_Client-${VERSION}-arm64.apk ($(du -h "$APK" | cut -f1))"
        else
            echo "[Sion] ATTENTION : APK de publication introuvable dans $APP_DIR/build/outputs/apk/"
            exit 1
        fi
        ;;
    dev)
        bun run tauri android dev
        ;;
    *)
        echo "Usage : $0 [debug|build|dev]"
        exit 1
        ;;
esac
