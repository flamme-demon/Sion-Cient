# Experiment: screen-share source picker on Windows (CEF 148)

## Problem
On Windows, Sion's screen share can only capture the **whole primary screen** —
no picker to choose a window / app / single monitor / region. On Linux it works
because `--enable-features=WebRtcPipeWireCapturer` (src-tauri/src/lib.rs) routes
`getDisplayMedia` through xdg-desktop-portal, which shows the system picker.
Windows has no portal equivalent; the picker is Chromium's own `DesktopMediaPicker`.

## What we know
- The picker exists in Chromium and is compiled into CEF 148 (color tokens
  `CEF_ColorDesktopMediaPicker*` present in the bindings).
- Sion's main window runs in **Chrome runtime** by default (cef_impl.rs:4810 —
  only `WebviewKind::WindowChild` defaults to Alloy; the main window is not a
  child). Chrome runtime is the one that has the picker. So runtime is NOT the blocker.
- The fork's `on_request_media_access_permission` (tauri-runtime-cef
  `src/cef_impl.rs`, ~line 1342 at rev 7372c8ee) only granted the **device**
  capture bits (`DEVICE_AUDIO/VIDEO_CAPTURE` = mic/camera) and returned 0
  (unhandled) for **desktop** capture (`DESKTOP_AUDIO/VIDEO_CAPTURE` = getDisplayMedia).
  Hypothesis: handling desktop capture lets CEF's Chrome runtime surface the picker
  instead of auto-selecting the primary screen.

Permission bit values (cef_media_access_permission_types_t, CEF 148):
DEVICE_AUDIO=1, DEVICE_VIDEO=2, DESKTOP_AUDIO=4, DESKTOP_VIDEO=8.

## The patch (apply to tauri-runtime-cef @ rev 7372c8ee)
File: `crates/tauri-runtime-cef/src/cef_impl.rs`, inside `on_request_media_access_permission`.

Replace:
```rust
      // Allow microphone and camera when requested
      let allowed = requested_permissions & (sys::cef_media_access_permission_types_t::CEF_MEDIA_PERMISSION_DEVICE_AUDIO_CAPTURE as u32 | sys::cef_media_access_permission_types_t::CEF_MEDIA_PERMISSION_DEVICE_VIDEO_CAPTURE as u32);
      if allowed != 0 {
        callback.cont(requested_permissions);
        return 1;
      }
      0
```
With:
```rust
      eprintln!("[Sion-cef] on_request_media_access_permission requested_permissions={requested_permissions:#x}");
      let allowed = requested_permissions & (
        sys::cef_media_access_permission_types_t::CEF_MEDIA_PERMISSION_DEVICE_AUDIO_CAPTURE as u32
        | sys::cef_media_access_permission_types_t::CEF_MEDIA_PERMISSION_DEVICE_VIDEO_CAPTURE as u32
        | sys::cef_media_access_permission_types_t::CEF_MEDIA_PERMISSION_DESKTOP_AUDIO_CAPTURE as u32
        | sys::cef_media_access_permission_types_t::CEF_MEDIA_PERMISSION_DESKTOP_VIDEO_CAPTURE as u32
      );
      if allowed != 0 {
        callback.cont(requested_permissions);
        return 1;
      }
      0
```

## ⚠️ Editing the cargo git checkout in place does NOT work
Cargo fingerprints **git** dependencies by their commit hash, NOT by file mtime.
So editing `~/.cargo/git/checkouts/tauri-*/7372c8e/.../cef_impl.rs` and rebuilding
will NOT recompile the crate (verified: touch + build = 0.35s, no recompile).
You MUST change the dependency *source* so cargo sees a new identity. Two ways:

### Method A — local path-patch (no GitHub, self-contained) — VERIFIED compiles
1. Copy the pinned tauri workspace to a local folder, e.g.:
   `cp -r ~/.cargo/git/checkouts/tauri-<hash>/7372c8e <repo>/vendor-tauri`
   (on Windows: copy `%USERPROFILE%\.cargo\git\checkouts\tauri-…\7372c8e` likewise)
2. Apply the patch above to `vendor-tauri/crates/tauri-runtime-cef/src/cef_impl.rs`.
3. In `src-tauri/Cargo.toml`, point ALL tauri crates at the local copy (path deps
   fingerprint by mtime → recompile). Change the direct dep:
   `tauri-runtime-cef = { path = "<…>/vendor-tauri/crates/tauri-runtime-cef", default-features = false, optional = true }`
   and ALL 7 entries under `[patch.crates-io]` from `git = …, rev = "7372c8ee"` to
   `path = "<…>/vendor-tauri/crates/<name>"`. Must patch ALL of them together (one
   path crate mixed with git siblings = duplicate `tauri-runtime` → conflict).
4. Build as usual. Run, start a screen share, observe the `[Sion-cef] …
   requested_permissions=0x…` log (0x8 = DESKTOP_VIDEO, 0xC = +audio) and whether a
   source picker now appears.
   (This exact path-patch was run on Linux: `Checking tauri-runtime-cef (path)` +
   exit 0 — the patch compiles cleanly. Linux screen share is unaffected; it uses
   the portal, not this handler's desktop grant.)

### Method B — fork (permanent / production)
Fork tauri-apps/tauri, check out 7372c8ee, apply the patch on a branch, push, then
repoint all `git = "https://github.com/tauri-apps/tauri", rev = "7372c8ee"` in
src-tauri/Cargo.toml (line ~42 + the `[patch.crates-io]` block) to your fork's
URL + the new commit sha. Build (Linux + Windows). This is the clean, committable fix.

## What to look for in the test
- `[Sion-cef] … requested_permissions=0x8` (or 0xC) → confirms getDisplayMedia's
  DESKTOP bits reach the handler. If you DON'T see it, the handler isn't even
  called for screen share → the picker gate is elsewhere.
- A window/screen/region picker appears → hypothesis confirmed, productionize via B.
- Still whole-screen-only despite granting → the picker is gated deeper in CEF's
  chrome-runtime wiring (not just permission); next step would be a custom picker
  or upstream CEF work.

## Status
- Verified the patch COMPILES on Linux (and that Linux screen share still works via the portal — the handler change is platform-neutral and shouldn't affect the Linux portal path).
- Windows behavior (does the picker appear?) is the open question — needs the Windows test above. If granting desktop capture does NOT surface the picker, the next step is deeper (CEF chrome-runtime picker wiring or a custom picker), and the `[Sion-cef]` log will at least confirm whether the handler is reached.
