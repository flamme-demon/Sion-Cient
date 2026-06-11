# Sion Client

A TeamSpeak-like voice and text client built on the [Matrix](https://matrix.org/) protocol with [LiveKit](https://livekit.io/) for real-time audio/video.

## Features

- **Voice channels** with low-latency audio via LiveKit (WebRTC)
- **AI noise suppression** — RNNoise denoise on the mic, runs off the main thread (AudioWorklet)
- **Text channels** with Markdown, file attachments, reactions, replies, message editing, polls
- **Video/audio playback** in chat with automatic ffmpeg transcoding for H.264 compatibility
- **URL media import** (yt-dlp) — bring audio/video from a link into chat or the soundboard
- **Screen sharing** in voice channels with dedicated viewer, system-audio capture (Linux), and a native cursor overlay
- **Soundboard** — shared server-wide sound library with per-sound category/emoji/hotkey/gain, in-app trimmer, LiveKit broadcast to voice participants
- **Voice & event sounds** — customizable join/leave/timeout cues plus poke / kicked / member-kicked notifications (custom file or URL per sound)
- **Link previews** with OG metadata extraction (YouTube oEmbed, GitHub, etc.)
- **End-to-end encryption** (E2EE) for both text and voice via Matrix Rust Crypto + LiveKit E2EE
- **Cross-device verification** (emoji comparison, recovery key)
- **Global keyboard shortcuts** for mute/deafen/soundboard (via rdev + tauri-plugin-global-shortcut)
- **Member panel** per room with inline promote/demote (moderator ↔ user)
- **User context menus** (profile, invite, kick, ban, power levels)
- **Admin panel** for Continuwuity server management — pending users + registration tokens
- **Cross-channel voice state** — mute/deafen visible in every channel's sidebar; AFK propagated via LiveKit data channel
- **Internationalization** (French default, English available)
- **Dark theme** with Material Design 3 inspired UI
- **Cross-platform** — Linux (AppImage), Windows (NSIS installer), Android (APK)

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh/) 1.3+ |
| Frontend | React 19.2, TypeScript 5.9, Vite 7.3, Tailwind CSS v4 |
| Desktop / Mobile | [Tauri v2](https://tauri.app/) with CEF runtime (Chromium); Android via APK |
| Matrix SDK | [matrix-js-sdk](https://github.com/element-hq/matrix-js-sdk) 41.6 |
| Voice/Video | [livekit-client](https://github.com/livekit/client-sdk-js) 2.19 |
| State | [Zustand](https://github.com/pmndrs/zustand) 5 |
| i18n | react-i18next 16, i18next 25 |

## Project Structure

```
src/
├── main.tsx, App.tsx, i18n.ts
├── types/              # TypeScript interfaces (matrix, livekit)
├── stores/             # Zustand stores (app, matrix, livekit, settings, admin)
├── services/           # Matrix, LiveKit, admin API services
├── hooks/              # React hooks (useMatrix, useLiveKit, useVoiceChannel)
├── utils/              # Emoji data, media decryption, message cache (IndexedDB)
└── components/
    ├── layout/         # Sidebar, MainArea, SettingsPanel, AdminPanel
    ├── sidebar/        # ServerHeader, ChannelList, UserControls, UserAvatar
    ├── chat/           # MessageList, Message, ChatInput, LinkPreview, MarkdownRenderer, ScreenShareView
    ├── admin/          # AdminStats, AdminActions, FederationInfo
    └── icons/          # SVG icon components
src-tauri/
├── src/lib.rs          # Tauri commands (shortcuts, link preview, open URL, video transcoding)
├── Cargo.toml          # Rust dependencies (tauri-cef, reqwest, scraper)
└── icons/              # App icons
build-scripts/
├── run-cef.sh          # Launch desktop app with CEF runtime (Linux)
├── build-appimage.sh   # Build Linux AppImage
├── install-linux.sh    # Install on Linux
├── build-windows.ps1   # Full Windows build (installs deps, compiles, bundles)
├── build-android.sh    # Build Android release APK
└── create-release.sh   # Create a GitHub Release + upload build artifacts
```

## Prerequisites

- [Bun](https://bun.sh/) >= 1.3
- [Rust](https://rustup.rs/) (stable)
- CMake + Ninja (for CEF compilation)
- [ffmpeg](https://ffmpeg.org/) (for video transcoding in chat — can also be auto-downloaded in-app)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (optional — for URL audio/video import; auto-downloadable in-app)
- A Matrix homeserver (tested with [Continuwuity](https://github.com/continuwuation/continuwuity))
- A LiveKit server for voice/video

## Development

```bash
# Install dependencies
bun install

# Start frontend dev server
bun run dev

# Start desktop app (Linux, CEF runtime)
./build-scripts/run-cef.sh

# Start desktop app (Linux, WRY fallback — no WebRTC)
bun run tauri dev
```

## Build

All build scripts are located in the `build-scripts/` directory.

### Linux — Install

```bash
./build-scripts/install-linux.sh
```

### Linux — AppImage

```bash
./build-scripts/build-appimage.sh
# Output: dist-appimage/Sion_Client-X.Y.Z-x86_64.AppImage
```

### Windows

```powershell
# Open PowerShell as Administrator
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\build-scripts\build-windows.ps1
```

The build script automatically installs missing dependencies (VS Build Tools, CMake, Ninja, Rust, Bun), compiles the application, and produces a **NSIS installer** (`.exe`) with bundled CEF libraries (the shipped Windows artifact).

### Android

```bash
./build-scripts/build-android.sh build   # signed release APK
```

### Releases (CI)

Pushing a `v*.*.*` tag triggers the GitHub Actions **Release** workflow, which
builds the Linux AppImage and Windows NSIS installer in parallel and publishes
a GitHub Release with both attached.

## Configuration

The client connects to a Matrix homeserver at login. Voice channels use MatrixRTC (MSC3401) to discover the LiveKit server endpoint.

**LiveKit token endpoint:** `POST /sfu/get` with `{room, openid_token, device_id}` returns `{url, jwt}`.

## Architecture

- Voice channel = Matrix room with custom `m.room.type`
- Joining a voice channel = `matrixClient.joinRoom()` + LiveKit token generation + LiveKit room connect
- Speaking indicator: client-side RMS detection via Web Audio API (sub-100ms latency, bypasses LiveKit SFU smoothing)
- Per-participant connection quality bars from LiveKit's `ConnectionQualityChanged` event
- User list = Matrix presence + LiveKit participants combined
- Link previews fetched server-side via Tauri command (reqwest + scraper / oEmbed)
- Video transcoding: MP4 (H.264) auto-transcoded to WebM (VP9) via system ffmpeg when native codec is unavailable
- Message history loaded via filtered `/messages` API — skips signaling events server-side for fast loading
- MatrixRTC encryption keys distributed via to-device messages (MSC4143) — no timeline pollution

## License

All rights reserved.
