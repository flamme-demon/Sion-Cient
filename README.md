# Sion Client

A TeamSpeak-like voice and text client built on the [Matrix](https://matrix.org/) protocol with [LiveKit](https://livekit.io/) for real-time audio/video.

## Features

- **Voice channels** with low-latency audio via LiveKit (WebRTC)
- **Text channels** with Markdown, file attachments, reactions, replies, message editing
- **Video/audio playback** in chat with automatic ffmpeg transcoding for H.264 compatibility
- **Screen sharing** in voice channels with dedicated viewer
- **Link previews** with OG metadata extraction (YouTube oEmbed, GitHub, etc.)
- **End-to-end encryption** (E2EE) for both text and voice via Matrix Rust Crypto + LiveKit E2EE
- **Cross-device verification** (emoji comparison, recovery key)
- **Global keyboard shortcuts** for mute/deafen (via rdev)
- **User context menus** (profile, invite, kick, ban, power levels)
- **Admin panel** for Continuwuity server management
- **Internationalization** (French default, English available)
- **Dark theme** with Material Design 3 inspired UI

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh/) 1.3+ |
| Frontend | React 19, TypeScript 5.9, Vite 7, Tailwind CSS v4 |
| Desktop | [Tauri v2](https://tauri.app/) with CEF runtime (Chromium) |
| Matrix SDK | [matrix-js-sdk](https://github.com/element-hq/matrix-js-sdk) 41.0 |
| Voice/Video | [livekit-client](https://github.com/livekit/client-sdk-js) 2.17 |
| State | [Zustand](https://github.com/pmndrs/zustand) 5 |
| i18n | react-i18next 16 |

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
├── fetch-cef-codecs.sh # Download standard CEF build with H.264 codecs
├── build-windows.ps1   # Full Windows build (installs deps, compiles, bundles)
├── build-appimage.sh   # Build Linux AppImage
└── install-linux.sh    # Install on Linux
```

## Prerequisites

- [Bun](https://bun.sh/) >= 1.3
- [Rust](https://rustup.rs/) (stable)
- CMake + Ninja (for CEF compilation)
- [ffmpeg](https://ffmpeg.org/) (for video transcoding in chat)
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
# Output: dist-appimage/Sion_Client-x86_64.AppImage
```

### Windows

```powershell
# Open PowerShell as Administrator
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\build-scripts\build-windows.ps1
```

The build script automatically installs missing dependencies (VS Build Tools, CMake, Ninja, Rust, Bun), compiles the application, and produces:
- **NSIS installer** (.exe) with bundled CEF libraries
- **MSI installer** with bundled CEF libraries
- **Standalone ZIP** (portable, no installation needed)

## Configuration

The client connects to a Matrix homeserver at login. Voice channels use MatrixRTC (MSC3401) to discover the LiveKit server endpoint.

**LiveKit token endpoint:** `POST /sfu/get` with `{room, openid_token, device_id}` returns `{url, jwt}`.

## Architecture

- Voice channel = Matrix room with custom `m.room.type`
- Joining a voice channel = `matrixClient.joinRoom()` + LiveKit token generation + LiveKit room connect
- Speaking indicator from `participant.isSpeaking` (LiveKit SDK)
- User list = Matrix presence + LiveKit participants combined
- Link previews fetched server-side via Tauri command (reqwest + scraper / oEmbed)
- Video transcoding: MP4 (H.264) auto-transcoded to WebM (VP9) via system ffmpeg when native codec is unavailable
- Message history loaded via filtered `/messages` API — skips signaling events server-side for fast loading
- MatrixRTC encryption keys distributed via to-device messages (MSC4143) — no timeline pollution

## License

All rights reserved.
