// Background global shortcuts via the XDG desktop portal
// (org.freedesktop.portal.GlobalShortcuts) — Linux only.
//
// Why not tauri-plugin-global-shortcut alone: its X11 backend resolves keys
// through US keysyms, so on non-QWERTY layouts punctuation keys either fail to
// register ("Backquote" → keysym `quoteleft`, absent from fr-oss) or grab the
// wrong physical key ("Quote" → keysym `apostrophe` = the "4" key on AZERTY).
// The portal inverts the responsibility: KWin/Mutter captures the keys itself
// and sends us an `Activated` D-Bus signal — layout handling is the
// compositor's problem, and capture works even in front of native Wayland
// windows (which neither rdev/XRecord nor XWayland grabs can see).
//
// Flow: `update()` is called on every shortcut change; it cancels the previous
// portal session and spawns a new one binding the current list. If the portal
// is unavailable (pure X11, old GNOME, wlroots) we fall back to the plugin
// path (`register_plugin_shortcuts`), preserving the pre-portal behaviour.
// The foreground rdev listener stays active in both cases; duplicate firings
// are absorbed by the 500 ms dedup in `push_shortcut_event`.

use std::collections::HashMap;
use std::sync::Mutex;

use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use futures_util::{
    future::{select, Either},
    StreamExt,
};

use crate::TauriRuntime;

/// Cancellation handle for the currently-running portal session task.
static CANCEL_CURRENT: Mutex<Option<tauri::async_runtime::Sender<()>>> = Mutex::new(None);

/// One shortcut to bind: `action` is the internal dispatch string sent over
/// the WS push channel ("mute", "deafen", "soundboard:<eventId>").
pub struct Binding {
    pub action: String,
    pub description: String,
    /// Stored combo in W3C `e.code` form ("Ctrl+KeyA", "Backquote").
    pub combo: String,
}

/// Replace the bound shortcut set. `fallback_payload` is re-used to register
/// through the plugin if the portal turns out to be unavailable.
pub fn update(
    app: tauri::AppHandle<TauriRuntime>,
    bindings: Vec<Binding>,
    fallback_payload: crate::UpdateShortcutsPayload,
) {
    // Cancel the previous session task (closes its portal session cleanly).
    let (cancel_tx, cancel_rx) = tauri::async_runtime::channel::<()>(1);
    if let Some(prev) = CANCEL_CURRENT.lock().unwrap().replace(cancel_tx) {
        let _ = prev.try_send(());
    }

    // Compute triggers now (sync X11 query for layout keysyms), not in the task.
    let shortcuts: Vec<(String, NewShortcut)> = bindings
        .iter()
        .filter(|b| !b.combo.is_empty())
        .map(|b| {
            // Include the combo in the portal id: KDE only prompts/rebinds for
            // ids it has never seen, so a trigger change must look like a new
            // shortcut or the old key would stay bound forever.
            let id = sanitize_id(&format!("{}-{}", b.action, b.combo));
            let mut sc = NewShortcut::new(id.clone(), b.description.clone());
            if let Some(trigger) = combo_to_xdg_trigger(&b.combo) {
                sc = sc.preferred_trigger(trigger.as_str());
            }
            (id, sc)
        })
        .collect();

    if shortcuts.is_empty() {
        return;
    }

    let id_to_action: HashMap<String, String> = bindings
        .iter()
        .filter(|b| !b.combo.is_empty())
        .map(|b| (sanitize_id(&format!("{}-{}", b.action, b.combo)), b.action.clone()))
        .collect();
    let new_shortcuts: Vec<NewShortcut> = shortcuts.into_iter().map(|(_, sc)| sc).collect();

    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_session(new_shortcuts, id_to_action, cancel_rx).await {
            log::warn!(
                "[Sion] GlobalShortcuts portal unavailable ({}), falling back to X11 grab plugin",
                e
            );
            crate::register_plugin_shortcuts(&app, &fallback_payload);
        }
    });
}

async fn run_session(
    shortcuts: Vec<NewShortcut>,
    id_to_action: HashMap<String, String>,
    mut cancel_rx: tauri::async_runtime::Receiver<()>,
) -> Result<(), ashpd::Error> {
    // Non-sandboxed apps have no app id the portal can derive on its own —
    // without this registration KDE answers BindShortcuts with
    // org.freedesktop.portal.Error.NotAllowed ("An app id is required").
    // Best-effort: the Registry interface needs xdg-desktop-portal ≥ 1.18.
    if let Err(e) = ashpd::register_host_app("com.sion.client".parse().unwrap()).await {
        log::info!("[Sion] Portal host-app registration unavailable: {}", e);
    }

    let portal = GlobalShortcuts::new().await?;
    let session = portal.create_session().await?;

    // Subscribe before binding so no early activation is missed.
    let activated = portal.receive_activated().await?;

    // The response resolves once the user confirms the compositor's dialog
    // (KDE only shows it for shortcut ids it has never seen before).
    let bind_request = portal.bind_shortcuts(&session, &shortcuts, None).await?;
    match bind_request.response() {
        Ok(resp) => {
            for sc in resp.shortcuts() {
                log::info!(
                    "[Sion] Portal shortcut bound: {} → {}",
                    sc.id(),
                    sc.trigger_description()
                );
            }
        }
        Err(e) => {
            log::warn!("[Sion] Portal BindShortcuts refused: {}", e);
            let _ = session.close().await;
            return Err(e);
        }
    }

    let mut activated = std::pin::pin!(activated);
    loop {
        let next = activated.next();
        let cancelled = std::pin::pin!(cancel_rx.recv());
        match select(next, cancelled).await {
            Either::Left((Some(ev), _)) => {
                if let Some(action) = id_to_action.get(ev.shortcut_id()) {
                    crate::push_shortcut_event(action);
                }
            }
            // Stream ended (portal gone) or update()/shutdown cancelled us.
            Either::Left((None, _)) | Either::Right(_) => break,
        }
    }
    let _ = session.close().await;
    Ok(())
}

/// Portal shortcut ids must stay within [A-Za-z0-9-._]; combos contain '+'
/// and soundboard actions embed Matrix event ids ("soundboard:$abc…").
fn sanitize_id(raw: &str) -> String {
    raw.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '-' })
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Build an XDG "shortcuts" spec trigger ("CTRL+SHIFT+<xkb keysym name>") from
/// a stored `e.code` combo. Returns None when no reliable keysym can be
/// derived — the shortcut is then bound trigger-less and the user assigns the
/// key in the compositor's dialog.
fn combo_to_xdg_trigger(combo: &str) -> Option<String> {
    let mut mods: Vec<&str> = Vec::new();
    let mut key: Option<String> = None;
    for tok in combo.split('+').map(str::trim).filter(|t| !t.is_empty()) {
        match tok {
            "Ctrl" => mods.push("CTRL"),
            "Shift" => mods.push("SHIFT"),
            "Alt" => mods.push("ALT"),
            "Meta" => mods.push("LOGO"),
            other => key = code_to_keysym_name(other),
        }
    }
    let key = key?;
    let mut trigger = mods.join("+");
    if !trigger.is_empty() {
        trigger.push('+');
    }
    trigger.push_str(&key);
    Some(trigger)
}

/// W3C code → xkb keysym name, layout-aware when possible: the physical
/// evdev keycode is fixed per code, and the *current layout's* keysym for it
/// is what the compositor expects in a trigger ("Backquote" → keycode 49 →
/// "twosuperior" on fr-oss, "grave" on us). Falls back to a static US name
/// when the X server can't be queried.
fn code_to_keysym_name(code: &str) -> Option<String> {
    if let Some(evdev) = code_to_evdev(code) {
        if let Some(name) = x11_layout_keysym_name(evdev + 8) {
            return Some(name);
        }
    }
    static_keysym_name(code)
}

/// Query the current keymap (via XWayland) for the unshifted keysym of a
/// keycode and return its xkb name (xkeysym reports "XK_twosuperior").
fn x11_layout_keysym_name(keycode: u8) -> Option<String> {
    use x11rb::protocol::xproto::ConnectionExt;
    let (conn, _) = x11rb::connect(None).ok()?;
    let reply = conn.get_keyboard_mapping(keycode, 1).ok()?.reply().ok()?;
    let sym = *reply.keysyms.first()?;
    if sym == 0 {
        return None;
    }
    xkeysym::Keysym::new(sym)
        .name()
        .map(|n| n.trim_start_matches("XK_").to_string())
}

/// Fixed physical mapping, W3C `e.code` → evdev KEY_* value (X11 keycode - 8).
fn code_to_evdev(code: &str) -> Option<u8> {
    let v = match code {
        "Escape" => 1,
        "Digit1" => 2, "Digit2" => 3, "Digit3" => 4, "Digit4" => 5, "Digit5" => 6,
        "Digit6" => 7, "Digit7" => 8, "Digit8" => 9, "Digit9" => 10, "Digit0" => 11,
        "Minus" => 12, "Equal" => 13, "Backspace" => 14, "Tab" => 15,
        "KeyQ" => 16, "KeyW" => 17, "KeyE" => 18, "KeyR" => 19, "KeyT" => 20,
        "KeyY" => 21, "KeyU" => 22, "KeyI" => 23, "KeyO" => 24, "KeyP" => 25,
        "BracketLeft" => 26, "BracketRight" => 27, "Enter" => 28,
        "KeyA" => 30, "KeyS" => 31, "KeyD" => 32, "KeyF" => 33, "KeyG" => 34,
        "KeyH" => 35, "KeyJ" => 36, "KeyK" => 37, "KeyL" => 38,
        "Semicolon" => 39, "Quote" => 40, "Backquote" => 41, "Backslash" => 43,
        "KeyZ" => 44, "KeyX" => 45, "KeyC" => 46, "KeyV" => 47, "KeyB" => 48,
        "KeyN" => 49, "KeyM" => 50, "Comma" => 51, "Period" => 52, "Slash" => 53,
        "NumpadMultiply" => 55, "Space" => 57, "CapsLock" => 58,
        "F1" => 59, "F2" => 60, "F3" => 61, "F4" => 62, "F5" => 63,
        "F6" => 64, "F7" => 65, "F8" => 66, "F9" => 67, "F10" => 68,
        "Numpad7" => 71, "Numpad8" => 72, "Numpad9" => 73, "NumpadSubtract" => 74,
        "Numpad4" => 75, "Numpad5" => 76, "Numpad6" => 77, "NumpadAdd" => 78,
        "Numpad1" => 79, "Numpad2" => 80, "Numpad3" => 81, "Numpad0" => 82,
        "NumpadDecimal" => 83, "IntlBackslash" => 86, "F11" => 87, "F12" => 88,
        "NumpadEnter" => 96, "NumpadDivide" => 98, "PrintScreen" => 99,
        "Home" => 102, "ArrowUp" => 103, "PageUp" => 104, "ArrowLeft" => 105,
        "ArrowRight" => 106, "End" => 107, "ArrowDown" => 108, "PageDown" => 109,
        "Insert" => 110, "Delete" => 111, "Pause" => 119,
        _ => return None,
    };
    Some(v)
}

/// US-layout keysym names, used only when the X11 layout query fails.
fn static_keysym_name(code: &str) -> Option<String> {
    let name = match code {
        "Space" => "space", "Enter" => "Return", "Escape" => "Escape",
        "Tab" => "Tab", "Backspace" => "BackSpace", "Delete" => "Delete",
        "Insert" => "Insert", "Home" => "Home", "End" => "End",
        "PageUp" => "Prior", "PageDown" => "Next",
        "ArrowUp" => "Up", "ArrowDown" => "Down",
        "ArrowLeft" => "Left", "ArrowRight" => "Right",
        "Minus" => "minus", "Equal" => "equal", "Comma" => "comma",
        "Period" => "period", "Slash" => "slash", "Backslash" => "backslash",
        "Semicolon" => "semicolon", "Quote" => "apostrophe",
        "Backquote" => "grave", "BracketLeft" => "bracketleft",
        "BracketRight" => "bracketright", "IntlBackslash" => "less",
        "CapsLock" => "Caps_Lock", "ScrollLock" => "Scroll_Lock",
        "Pause" => "Pause", "PrintScreen" => "Print",
        "NumpadEnter" => "KP_Enter", "NumpadAdd" => "KP_Add",
        "NumpadSubtract" => "KP_Subtract", "NumpadMultiply" => "KP_Multiply",
        "NumpadDivide" => "KP_Divide", "NumpadDecimal" => "KP_Decimal",
        s if s.len() == 4 && s.starts_with("Key") => return Some(s[3..].to_ascii_lowercase()),
        s if s.len() == 6 && s.starts_with("Digit") => return Some(s[5..].to_string()),
        s if s.starts_with('F') && s[1..].parse::<u8>().map_or(false, |n| (1..=24).contains(&n)) => s,
        s if s.len() == 7 && s.starts_with("Numpad") && s.as_bytes()[6].is_ascii_digit() => {
            return Some(format!("KP_{}", &s[6..]))
        }
        _ => return None,
    };
    Some(name.to_string())
}
