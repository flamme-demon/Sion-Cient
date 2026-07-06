// Layout-aware global hotkeys on Windows.
//
// Why not tauri-plugin-global-shortcut here: global-hotkey translates W3C
// codes through a fixed US table (Code::Backquote → VK_OEM_3), but VK_OEM_*
// — and even letter VKs — follow the *characters* of the active layout, not
// physical positions. On French AZERTY, VK_OEM_3 is the ù key and the ² key
// (physical Backquote, scancode 0x29) emits VK_OEM_7, so shortcuts silently
// bind to the wrong keys (same failure class as the X11 keysym path fixed by
// portal_shortcuts.rs on Linux).
//
// Instead we resolve the stored physical code to a scancode (set-1 scancodes
// equal the evdev values used in portal_shortcuts.rs for the main block),
// ask the *current* layout for the matching virtual key via
// MapVirtualKeyExW(MAPVK_VSC_TO_VK_EX), and register it ourselves with
// RegisterHotKey on a dedicated message-loop thread (hotkeys only fire on
// the thread that registered them). WM_HOTKEY → push_shortcut_event, same
// WS push channel as every other backend.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;

use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyboardLayout, MapVirtualKeyExW, RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS,
    MAPVK_VSC_TO_VK_EX, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW, TranslateMessage, MSG,
    PM_NOREMOVE, WM_HOTKEY, WM_QUIT, WM_USER,
};

/// Message-loop thread currently owning the registered hotkeys (0 = none).
static WORKER_THREAD_ID: AtomicU32 = AtomicU32::new(0);

pub struct Binding {
    /// Dispatch string pushed over the WS channel ("mute", "deafen",
    /// "soundboard:<eventId>").
    pub action: String,
    /// Stored combo in W3C `e.code` form ("Ctrl+KeyA", "Backquote").
    pub combo: String,
}

/// Replace the registered hotkey set. Combos that can't be resolved on the
/// current layout are logged and skipped (they can't be expressed as a VK).
pub fn update(bindings: Vec<Binding>) {
    // Stop the previous worker; it unregisters its hotkeys on the way out.
    let prev = WORKER_THREAD_ID.swap(0, Ordering::AcqRel);
    if prev != 0 {
        unsafe { let _ = PostThreadMessageW(prev, WM_QUIT, WPARAM(0), LPARAM(0)); }
    }

    let mut hotkeys: Vec<(i32, HOT_KEY_MODIFIERS, u32, String)> = Vec::new();
    for (idx, b) in bindings.iter().enumerate() {
        if b.combo.is_empty() {
            continue;
        }
        match combo_to_hotkey(&b.combo) {
            Some((mods, vk)) => hotkeys.push((idx as i32 + 1, mods, vk, b.action.clone())),
            None => log::warn!(
                "[Sion] Hotkey combo '{}' has no key on the current Windows layout, skipped",
                b.combo
            ),
        }
    }
    if hotkeys.is_empty() {
        return;
    }

    let (tid_tx, tid_rx) = mpsc::channel::<u32>();
    std::thread::spawn(move || unsafe {
        // Force-create this thread's message queue before publishing our id,
        // so an immediate PostThreadMessageW(WM_QUIT) can't be lost.
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
        let tid = windows::Win32::System::Threading::GetCurrentThreadId();
        let _ = tid_tx.send(tid);

        let mut registered: HashMap<i32, String> = HashMap::new();
        for (id, mods, vk, action) in hotkeys {
            match RegisterHotKey(None, id, mods | MOD_NOREPEAT, vk) {
                Ok(()) => {
                    log::info!("[Sion] Win hotkey registered: {} (vk=0x{:X})", action, vk);
                    registered.insert(id, action);
                }
                Err(e) => log::warn!("[Sion] RegisterHotKey failed for {}: {}", action, e),
            }
        }

        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_HOTKEY {
                if let Some(action) = registered.get(&(msg.wParam.0 as i32)) {
                    crate::push_shortcut_event(action);
                }
            } else {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        for id in registered.keys() {
            let _ = UnregisterHotKey(None, *id);
        }
    });

    if let Ok(tid) = tid_rx.recv_timeout(std::time::Duration::from_secs(2)) {
        // If another update() raced us and already installed a newer worker,
        // shut ours down instead of clobbering theirs.
        if WORKER_THREAD_ID
            .compare_exchange(0, tid, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            unsafe { let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0)); }
        }
    }
}

/// "Ctrl+Shift+Backquote" → (MOD_CONTROL|MOD_SHIFT, layout-resolved VK).
fn combo_to_hotkey(combo: &str) -> Option<(HOT_KEY_MODIFIERS, u32)> {
    let mut mods = HOT_KEY_MODIFIERS(0);
    let mut vk: Option<u32> = None;
    for tok in combo.split('+').map(str::trim).filter(|t| !t.is_empty()) {
        match tok {
            "Ctrl" => mods |= MOD_CONTROL,
            "Shift" => mods |= MOD_SHIFT,
            "Alt" => mods |= MOD_ALT,
            "Meta" => mods |= MOD_WIN,
            other => vk = code_to_vk(other),
        }
    }
    vk.map(|vk| (mods, vk))
}

/// W3C code → virtual key. Position-independent keys (F-keys, nav, numpad)
/// have fixed VKs; everything in the typing block goes scancode → VK through
/// the active layout so physical positions are honoured on AZERTY & co.
fn code_to_vk(code: &str) -> Option<u32> {
    if let Some(vk) = fixed_vk(code) {
        return Some(vk);
    }
    let sc = code_to_scancode(code)?;
    let vk = unsafe { MapVirtualKeyExW(sc as u32, MAPVK_VSC_TO_VK_EX, GetKeyboardLayout(0)) };
    if vk == 0 {
        None
    } else {
        Some(vk)
    }
}

/// Layout-independent virtual keys.
fn fixed_vk(code: &str) -> Option<u32> {
    let vk = match code {
        "Escape" => 0x1B, "Tab" => 0x09, "Space" => 0x20, "Enter" => 0x0D,
        "Backspace" => 0x08, "Delete" => 0x2E, "Insert" => 0x2D,
        "Home" => 0x24, "End" => 0x23, "PageUp" => 0x21, "PageDown" => 0x22,
        "ArrowLeft" => 0x25, "ArrowUp" => 0x26, "ArrowRight" => 0x27, "ArrowDown" => 0x28,
        "CapsLock" => 0x14, "ScrollLock" => 0x91, "Pause" => 0x13, "PrintScreen" => 0x2C,
        "NumpadMultiply" => 0x6A, "NumpadAdd" => 0x6B, "NumpadSubtract" => 0x6D,
        "NumpadDecimal" => 0x6E, "NumpadDivide" => 0x6F,
        // RegisterHotKey can't tell the two Enter keys apart.
        "NumpadEnter" => 0x0D,
        s if s.len() == 7 && s.starts_with("Numpad") && s.as_bytes()[6].is_ascii_digit() => {
            0x60 + (s.as_bytes()[6] - b'0') as u32
        }
        s if s.starts_with('F') => {
            let n: u32 = s[1..].parse().ok().filter(|n| (1..=24).contains(n))?;
            0x70 + n - 1
        }
        _ => return None,
    };
    Some(vk)
}

/// W3C code → set-1 scancode (typing block only; identical to the evdev
/// values used by portal_shortcuts.rs on Linux).
fn code_to_scancode(code: &str) -> Option<u8> {
    let v = match code {
        "Digit1" => 0x02, "Digit2" => 0x03, "Digit3" => 0x04, "Digit4" => 0x05,
        "Digit5" => 0x06, "Digit6" => 0x07, "Digit7" => 0x08, "Digit8" => 0x09,
        "Digit9" => 0x0A, "Digit0" => 0x0B, "Minus" => 0x0C, "Equal" => 0x0D,
        "KeyQ" => 0x10, "KeyW" => 0x11, "KeyE" => 0x12, "KeyR" => 0x13, "KeyT" => 0x14,
        "KeyY" => 0x15, "KeyU" => 0x16, "KeyI" => 0x17, "KeyO" => 0x18, "KeyP" => 0x19,
        "BracketLeft" => 0x1A, "BracketRight" => 0x1B,
        "KeyA" => 0x1E, "KeyS" => 0x1F, "KeyD" => 0x20, "KeyF" => 0x21, "KeyG" => 0x22,
        "KeyH" => 0x23, "KeyJ" => 0x24, "KeyK" => 0x25, "KeyL" => 0x26,
        "Semicolon" => 0x27, "Quote" => 0x28, "Backquote" => 0x29, "Backslash" => 0x2B,
        "KeyZ" => 0x2C, "KeyX" => 0x2D, "KeyC" => 0x2E, "KeyV" => 0x2F, "KeyB" => 0x30,
        "KeyN" => 0x31, "KeyM" => 0x32, "Comma" => 0x33, "Period" => 0x34, "Slash" => 0x35,
        "IntlBackslash" => 0x56,
        _ => return None,
    };
    Some(v)
}
