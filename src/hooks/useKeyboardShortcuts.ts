import { useEffect, useRef } from "react";
import { useAppStore } from "../stores/useAppStore";
import { useSettingsStore } from "../stores/useSettingsStore";

function keyEventToString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");
  if (!["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  }
  return parts.join("+");
}

export { keyEventToString };

let lastSyncedShortcuts = "";
async function syncShortcutsToBackend(mute: string, deafen: string) {
  const key = `${mute}|${deafen}`;
  if (key === lastSyncedShortcuts) return;
  lastSyncedShortcuts = key;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { loadHotkeys } = await import("../services/soundboardHotkeys");
    const map = loadHotkeys();
    const soundboard = Object.entries(map).map(([id, combo]) => ({ id, combo }));
    await invoke("update_shortcuts", { payload: { mute, deafen, soundboard } });
  } catch { /* Not in Tauri */ }
}

export function useKeyboardShortcuts() {
  const toggleMute = useAppStore((s) => s.toggleMute);
  const toggleDeafen = useAppStore((s) => s.toggleDeafen);
  const muteShortcut = useSettingsStore((s) => s.muteShortcut);
  const deafenShortcut = useSettingsStore((s) => s.deafenShortcut);
  const lastToggleRef = useRef<number>(0);

  const debouncedMute = () => {
    const now = Date.now();
    if (now - lastToggleRef.current > 300) {
      lastToggleRef.current = now;
      toggleMute();
    }
  };

  const debouncedDeafen = () => {
    const now = Date.now();
    if (now - lastToggleRef.current > 300) {
      lastToggleRef.current = now;
      toggleDeafen();
    }
  };

  useEffect(() => {
    // Android has no global-shortcut backend (no rdev, no global-shortcut
    // plugin enabled); the Tauri command would be missing and we'd spam
    // the console with rejected invokes on every settings change.
    if (/Android/i.test(navigator.userAgent)) return;
    syncShortcutsToBackend(muteShortcut, deafenShortcut);
  }, [muteShortcut, deafenShortcut]);

  // Push-based WebSocket: Rust pushes "mute,ts" or "deafen,ts" instantly
  // when rdev/plugin detects a global shortcut. No polling needed.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    // No background WS server on Android — same reason as above.
    if (/Android/i.test(navigator.userAgent)) return;
    let ws: WebSocket | null = null;
    let alive = true;

    const connectWs = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const port = await invoke<number>("get_shortcut_ws_port");
        if (!port || !alive) return;

        ws = new WebSocket(`ws://127.0.0.1:${port}`);

        ws.onmessage = (ev) => {
          const data = typeof ev.data === "string" ? ev.data : "";
          const parts = data.split(",");
          if (parts.length < 1) return;
          const action = parts[0];
          if (action === "mute") debouncedMute();
          else if (action === "deafen") debouncedDeafen();
          else if (action.startsWith("soundboard:")) {
            // Respect the global toggle — if soundboard is disabled, hotkeys
            // don't fire anything locally and don't broadcast.
            if (!useSettingsStore.getState().soundboardEnabled) return;
            const eventId = action.slice("soundboard:".length);
            import("../services/soundboardService").then(async ({ listSounds, playSoundLocal, broadcastSound }) => {
              const sounds = await listSounds();
              const sound = sounds.find((s) => s.eventId === eventId);
              if (!sound) return;
              try {
                await playSoundLocal(sound.mxcUrl);
                const { useAppStore } = await import("../stores/useAppStore");
                if (useAppStore.getState().connectedVoiceChannel) broadcastSound(sound.mxcUrl);
              } catch (err) {
                console.warn("[Sion] soundboard hotkey play failed:", err);
              }
            }).catch(() => {});
          }
        };

        ws.onclose = () => {
          if (alive) setTimeout(connectWs, 1000);
        };
        ws.onerror = () => ws?.close();
      } catch {
        if (alive) setTimeout(connectWs, 2000);
      }
    };

    connectWs();
    return () => {
      alive = false;
      if (ws) { ws.onclose = null; ws.close(); }
    };
  }, [toggleMute, toggleDeafen]);

  // Web keydown — only used in browser dev mode (no Tauri).
  // In Tauri, rdev + plugin handle all shortcuts via WS push.
  useEffect(() => {
    if (window.__TAURI_INTERNALS__) return;
    if (!muteShortcut && !deafenShortcut) return;

    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isFKey = /^F\d{1,2}$/.test(e.key);
      const hasModifier = e.ctrlKey || e.altKey || e.metaKey;
      if ((tag === "INPUT" || tag === "TEXTAREA") && !isFKey && !hasModifier) return;
      const combo = keyEventToString(e);
      if (muteShortcut && combo === muteShortcut) {
        e.preventDefault();
        debouncedMute();
      }
      if (deafenShortcut && combo === deafenShortcut) {
        e.preventDefault();
        debouncedDeafen();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [muteShortcut, deafenShortcut, toggleMute, toggleDeafen]);
}
