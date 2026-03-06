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

// Send shortcut config to Tauri backend
async function syncShortcutsToBackend(mute: string, deafen: string) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("update_shortcuts", { payload: { mute, deafen } });
  } catch {
    // Not in Tauri
  }
}

export function useKeyboardShortcuts() {
  const toggleMute = useAppStore((s) => s.toggleMute);
  const toggleDeafen = useAppStore((s) => s.toggleDeafen);
  const muteShortcut = useSettingsStore((s) => s.muteShortcut);
  const deafenShortcut = useSettingsStore((s) => s.deafenShortcut);
  // Debounce to prevent double-toggle (rdev global + web keydown both fire when focused)
  const lastToggleRef = useRef<number>(0);

  const debouncedMute = () => {
    const now = Date.now();
    if (now - lastToggleRef.current > 150) {
      lastToggleRef.current = now;
      toggleMute();
    }
  };

  const debouncedDeafen = () => {
    const now = Date.now();
    if (now - lastToggleRef.current > 150) {
      lastToggleRef.current = now;
      toggleDeafen();
    }
  };

  // Sync shortcuts to Tauri backend
  useEffect(() => {
    syncShortcutsToBackend(muteShortcut, deafenShortcut);
  }, [muteShortcut, deafenShortcut]);

  // Listen for global shortcut events from Tauri (rdev backend)
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<string>("global-shortcut", (event) => {
          if (event.payload === "mute") debouncedMute();
          if (event.payload === "deafen") debouncedDeafen();
        });
      } catch {
        // Not in Tauri
      }
    })();

    return () => { if (unlisten) unlisten(); };
  }, [toggleMute, toggleDeafen]);

  // Web fallback: keydown listener (browser dev mode only)
  useEffect(() => {
    if (!muteShortcut && !deafenShortcut) return;
    if (window.__TAURI_INTERNALS__) return;

    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
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
