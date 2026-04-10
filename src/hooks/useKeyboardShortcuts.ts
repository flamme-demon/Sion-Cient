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
    await invoke("update_shortcuts", { payload: { mute, deafen } });
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
    syncShortcutsToBackend(muteShortcut, deafenShortcut);
  }, [muteShortcut, deafenShortcut]);

  // Push-based WebSocket: Rust pushes "mute,ts" or "deafen,ts" instantly
  // when rdev/plugin detects a global shortcut. No polling needed.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
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
