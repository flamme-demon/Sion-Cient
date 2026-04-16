/**
 * Soundboard hotkeys — stored in localStorage and synced to the Tauri
 * backend so the global-shortcut plugin can capture combos even when Sion
 * is not focused. The backend pushes matched combos back via the same
 * WebSocket used for mute/deafen (action = `soundboard:<eventId>`).
 */

const STORAGE_KEY = "sion.soundboard.hotkeys";

export interface HotkeyMap {
  [eventId: string]: string; // combo string, e.g. "F1" or "Ctrl+Shift+1"
}

export function loadHotkeys(): HotkeyMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (typeof parsed === "object" && parsed !== null) ? parsed as HotkeyMap : {};
  } catch {
    return {};
  }
}

function saveHotkeys(map: HotkeyMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function setHotkey(eventId: string, combo: string | null) {
  const map = loadHotkeys();
  if (combo === null) delete map[eventId];
  else map[eventId] = combo;
  saveHotkeys(map);
  syncToBackend();
  notifyChange();
}

/** Remove entries referencing event ids that are no longer in the sound list. */
export function pruneHotkeys(knownEventIds: Set<string>) {
  const map = loadHotkeys();
  let changed = false;
  for (const id of Object.keys(map)) {
    if (!knownEventIds.has(id)) {
      delete map[id];
      changed = true;
    }
  }
  if (changed) {
    saveHotkeys(map);
    syncToBackend();
    notifyChange();
  }
}

/** Returns the combo currently used for a given sound, or null. */
export function getHotkey(eventId: string): string | null {
  return loadHotkeys()[eventId] ?? null;
}

/** Returns the eventId currently bound to a combo, or null. */
export function findConflict(combo: string, excludeEventId: string | null = null): string | null {
  const map = loadHotkeys();
  for (const [id, c] of Object.entries(map)) {
    if (c === combo && id !== excludeEventId) return id;
  }
  return null;
}

// Global listeners to notify the UI when hotkeys change (for live re-render)
const listeners = new Set<() => void>();
export function onHotkeysChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notifyChange() {
  for (const cb of listeners) { try { cb(); } catch { /* ignore */ } }
}

/** Send the full hotkey list to the Rust backend for global capture. */
let syncing = false;
async function syncToBackend() {
  if (syncing) return;
  syncing = true;
  try {
    if (!window.__TAURI_INTERNALS__) return;
    if (/Android/i.test(navigator.userAgent)) return;
    const { invoke } = await import("@tauri-apps/api/core");
    // Reuse the mute/deafen store so we don't race with the keyboard-shortcut
    // hook. Read current mute/deafen from the settings store.
    const { useSettingsStore } = await import("../stores/useSettingsStore");
    const map = loadHotkeys();
    const soundboard = Object.entries(map).map(([id, combo]) => ({ id, combo }));
    await invoke("update_shortcuts", {
      payload: {
        mute: useSettingsStore.getState().muteShortcut,
        deafen: useSettingsStore.getState().deafenShortcut,
        soundboard,
      },
    });
  } catch (err) {
    console.warn("[Sion] soundboard hotkey sync failed:", err);
  } finally {
    syncing = false;
  }
}

/** Force a re-sync — call when hotkeys need to re-register (e.g. after Tauri window reopens). */
export function resyncHotkeys() {
  syncToBackend();
}

// F-keys intercepted by CEF (help, find, reload, caret, fullscreen, devtools)
// — the OS plugin captures them before CEF only if the user manages to enter
// them via manual input (the live keydown capture never sees them).
const CEF_RESERVED_F_KEYS = new Set(["F1", "F3", "F5", "F7", "F11", "F12"]);

/** Valide une combo avant attribution. Retourne le message d'erreur ou null si OK. */
export function validateCombo(combo: string, muteShortcut: string, deafenShortcut: string): string | null {
  if (!combo) return "Combo vide";
  if (combo === muteShortcut) return "Conflit avec le raccourci mute";
  if (combo === deafenShortcut) return "Conflit avec le raccourci sourdine";
  // F12 is reserved for Sion (dev tools).
  if (combo === "F12" || combo.endsWith("+F12")) return "F12 est réservé";

  const parts = combo.split("+");
  const main = parts[parts.length - 1];
  const hasModifier = parts.length > 1 && parts.slice(0, -1).some((p) => ["Ctrl", "Shift", "Alt", "Meta"].includes(p));

  // A plain single character or number without modifier would swallow text
  // input — reject. Function keys (F1..F11) are OK without modifier.
  if (!hasModifier) {
    if (/^F([1-9]|1[01])$/.test(main)) {
      if (CEF_RESERVED_F_KEYS.has(main)) {
        return `${main} est réservée par CEF (aide/recherche/reload/plein-écran). Choisissez F2/F4/F6/F8/F9/F10 ou un combo Ctrl+/Alt+`;
      }
      return null;
    }
    return "Touche simple refusée — combinez avec Ctrl/Shift/Alt ou utilisez F2/F4/F6/F8/F9/F10";
  }
  return null;
}

/**
 * Accepts a user-typed combo string and normalizes it to our canonical
 * "Ctrl+Shift+F1" format. Handles aliases (Control → Ctrl, ⌘ → Meta, etc.).
 */
export function normalizeManualCombo(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const normalized: string[] = [];
  const modifiers: string[] = [];
  for (const raw of parts) {
    const p = raw.toLowerCase();
    if (p === "ctrl" || p === "control" || p === "commandorcontrol") modifiers.push("Ctrl");
    else if (p === "shift") modifiers.push("Shift");
    else if (p === "alt" || p === "option") modifiers.push("Alt");
    else if (p === "meta" || p === "cmd" || p === "command" || p === "super" || p === "win") modifiers.push("Meta");
    else normalized.push(raw);
  }
  if (normalized.length !== 1) return null;

  // Normalize the main key: single letter uppercase, F-key uppercase, else keep
  let main = normalized[0];
  if (/^[a-z]$/i.test(main)) main = main.toUpperCase();
  else if (/^f\d{1,2}$/i.test(main)) main = main.toUpperCase();

  const orderedMods = ["Ctrl", "Shift", "Alt", "Meta"].filter((m) => modifiers.includes(m));
  return [...orderedMods, main].join("+");
}
