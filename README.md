# Sion Client

A TeamSpeak-like voice and text client built on the [Matrix](https://matrix.org/) protocol with [LiveKit](https://livekit.io/) for real-time audio/video — on Linux, Windows and Android.

> **Status:** 2.0 is in beta (download it from [Releases](https://github.com/flamme-demon/Sion-Client/releases): AppImage, Windows installer, Android APK). The last stable release is 1.6.4; its maintenance branch is `release/1.6`. Upgrading from 1.x asks for the password once, then takes over the old session: the device stays verified and encrypted history stays readable.

## Features

**Voice**
- **Voice channels** — native LiveKit/WebRTC engine in Rust, outside the webview; push-to-talk or open mic, mute/deafen visible in every channel's sidebar
- **Noise suppression** — RNNoise inside WebRTC's capture pipeline, alongside echo cancellation and automatic gain
- **Screen sharing** with a dedicated viewer, system-audio capture, a native cursor overlay, and received video that can be hidden to save data and battery
- **Soundboard & memeboard** — shared server-wide sounds and video memes, played to everyone in the call; per-sound category, emoji, hotkey and gain, in-app trimmer, URL import (yt-dlp)
- **Generated voices** — clone a voice from a short reference clip and make it say anything, entirely locally (audio.cpp / ggml, Vulkan-accelerated; engine and models downloaded on demand)
- **Meeting transcription** — consent-based, each participant transcribing their own mic locally (whisper.cpp / Parakeet v3); live panel, history, and meeting minutes generated locally (llama.cpp)
- **Voice & event sounds** — join/leave/timeout cues, poke and kick notifications

**Text**
- Markdown, replies, reactions, edits, polls, pinned messages, file attachments, link previews
- Video and audio playback in chat (ffmpeg bundled on desktop)
- Unread tracking with a "new messages" marker; desktop notifications (with inline reply on KDE)

**Security & accounts**
- **End-to-end encryption** for text and voice: [matrix-rust-sdk](https://github.com/matrix-org/matrix-rust-sdk) crypto + LiveKit E2EE, keys distributed over MatrixRTC
- **Device verification** by QR code, emoji comparison or recovery key
- **Phone sign-in by QR code** — on the PC, *Account → Connect a phone*; the phone scans it and signs in without typing anything (single-use `m.login.token`, 2 minutes)

**Android**
- The same client on phones: native voice (Rust), push-to-talk, soundboard and memeboard, screen shares
- **Push notifications without Google services** — Sion keeps its own connection to an [ntfy](https://ntfy.sh/) server (Matrix push gateway); notifications arrive with the app closed, and can be answered inline

**Everything else**
- Customizable layout: dockable/floating panels, themes and accent colour, exportable profiles (`.sionprofil`)
- Global keyboard shortcuts (mute/deafen/soundboard), including AZERTY keys
- Admin panel for [Continuwuity](https://github.com/continuwuation/continuwuity) (pending users, registration tokens, server stats and actions)
- French (default) and English

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh/) 1.3+ |
| Frontend | React 19.2, TypeScript 5.9, Vite 7.3, Tailwind CSS v4, Zustand 5 |
| App shell | [Tauri 2](https://tauri.app/) with WRY — WebKitGTK (Linux), WebView2 (Windows), Android WebView |
| Matrix | Rust core `sion-matrix` on [matrix-sdk](https://crates.io/crates/matrix-sdk) 0.19 (sync, crypto, verification, MatrixRTC). matrix-js-sdk remains only to migrate 1.x sessions |
| Voice/Video | LiveKit Rust SDK (`livekit` + a patched `webrtc-sys`), native audio device and RNNoise |
| i18n | react-i18next 16, i18next 25 |

## Project Structure

```
src/                     # React UI
├── services/            # matrixCore.ts (bridge to the Rust core), push, updates…
├── stores/              # Zustand stores
├── components/          # layout, sidebar, chat, admin, qr…
└── pages/               # login
src-tauri/
├── src/                 # Tauri app: commands, native voice (voice_engine.rs),
│                        #   media server, notifications, Android glue
├── sion-matrix/         # Rust Matrix core (matrix-sdk): rooms, timelines,
│                        #   verification, MatrixRTC voice membership and keys
├── native-audio/        # RNNoise and audio processing for WebRTC capture
├── vendor/webrtc-sys/   # patched LiveKit webrtc-sys (see its SION_PATCH.md)
└── gen/android/         # Android project (Kotlin services, Gradle)
build-scripts/           # run, build and release scripts (see below)
docs/                    # plans and release notes
```

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.3 and [Rust](https://rustup.rs/) stable (≥ 1.96, required by matrix-sdk)
- clang ≥ 21 on Linux (the prebuilt libwebrtc ships a hermetic libc++), CMake + Ninja
- Android: SDK, NDK 27.2, JDK 17 and the `aarch64-linux-android` Rust target
- A Matrix homeserver (tested with [Continuwuity](https://github.com/continuwuation/continuwuity)) and a LiveKit server with its MatrixRTC token service (`/sfu/get`)
- Optional, downloaded in-app when needed: ffmpeg, yt-dlp, audio.cpp

## Development

```bash
bun install
./build-scripts/run-native.sh        # desktop app (Linux), Vite hot reload
bun run tauri dev                    # desktop app (Windows)
./build-scripts/build-android.sh debug   # "Sion Dev" APK, installed next to the released app
```

## Testing

```bash
bunx tsc -b                          # typecheck (the root tsconfig is a solution file:
                                     #   `tsc --noEmit` against it checks nothing)
bun run lint
bun run test                         # vitest
cd src-tauri && cargo test -j4       # Rust suites (app + sion-matrix core)
```

Integration tests of the Matrix core (`src-tauri/sion-matrix/tests/`) run against a disposable local Continuwuity server and are ignored by default; each file explains how to run it.

CI runs these checks on every push and PR to `main` (`.github/workflows/ci.yml`), and the Matrix core tests whenever the core changes (`matrix-rust.yml`). To run the same gate before each push, enable the versioned hook once per clone:

```bash
git config core.hooksPath .githooks
```

## Build

```bash
./build-scripts/build-appimage.sh          # Linux AppImage → dist-appimage/
./build-scripts/install-linux.sh           # install on Linux
./build-scripts/build-android.sh build     # Android release APK → build-apps/
```

On Windows, `build-scripts\build-windows.ps1` (PowerShell as administrator) installs the missing tools and produces the NSIS installer.

The Android release APK must be signed with the key of the published versions, or Android refuses to install it over them: `build-scripts/verifier-cle-android.sh` checks a keystore (password, alias, certificate) without building anything.

### Releases (CI)

Pushing a `v*.*.*` tag triggers the **Release** workflow: Linux AppImage, Windows installer and signed Android APK are built in parallel and published as a GitHub Release (a pre-release when the tag has a suffix such as `-beta.4`). Release notes come from `docs/release-notes-<version>.md`. The Android job needs the `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD` secrets (plus `ANDROID_KEY_PASSWORD` if the key has its own); the manual **Vérifier la clé Android** workflow checks them in a minute.

## Architecture

- A voice channel is a Matrix room; being in its call is a MatrixRTC membership (`org.matrix.msc3401.call.member`), published and renewed by the Rust core, which also distributes the per-call media keys as encrypted to-device messages
- Joining = OpenID token → LiveKit token service (`/sfu/get`) → native LiveKit connection; audio never goes through the webview
- The UI talks to the Rust core through Tauri commands and events (`src/services/matrixCore.ts`); media are served to the webview by the core (`sion-media://`), decrypted on the fly
- Participant list = MatrixRTC memberships merged with LiveKit participants, per device (phone and PC can be in the same call)

## License

Sion is free software, licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

at your option. Forks and derivative works — including commercial ones — are
welcome, as long as the copyright notice is kept.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in Sion shall be dual-licensed as above, without any additional
terms or conditions.
