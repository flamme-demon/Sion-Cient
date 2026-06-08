// Mirrors the critical session keys (auth credentials + device/user id) from
// localStorage to a file in the Tauri app-data dir, OUTSIDE the Chromium/CEF
// profile. localStorage lives inside that profile and gets reset on a CEF
// major upgrade (observed 144→148: logged out + new device + recovery-key
// re-entry) and by the "purge cache" action. Persisting these keys externally
// lets us re-hydrate localStorage on boot so the session resumes seamlessly —
// no forced re-login, no new device, no recovery-key prompt.
//
// localStorage access is synchronous but Tauri IPC is async, so we hydrate
// ONCE at boot (before the stores read localStorage) and mirror on every write.

// The keys whose loss forces a re-login / new device / re-verification, plus
// the user's settings and login prefill — everything that should survive a
// CEF/Chromium profile reset. `sion-settings` is the Zustand persist key
// (useSettingsStore { name: "sion-settings" }).
const KEYS = [
  "sion_auth_credentials",
  "sion_device_id",
  "sion_user_id",
  "sion-settings",
  "sion_last_homeserver",
  "sion_last_username",
] as const;

function isTauri(): boolean {
  return typeof window !== "undefined" &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

async function getInvoke() {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

/** Write the current snapshot of the session keys to app-data. Fire-and-forget;
 *  any failure is swallowed so it can never break the auth flow. */
export async function mirrorSessionToAppData(): Promise<void> {
  if (!isTauri()) return;
  try {
    const blob: Record<string, string> = {};
    for (const k of KEYS) {
      const v = localStorage.getItem(k);
      if (v !== null) blob[k] = v;
    }
    const invoke = await getInvoke();
    await invoke("persist_session", { json: JSON.stringify(blob) });
  } catch {
    /* best-effort — never throw into the caller */
  }
}

/** Restore session keys from app-data into localStorage when localStorage is
 *  missing them (e.g. after a CEF upgrade wiped the profile). Never clobbers a
 *  value already present in localStorage. Must run BEFORE stores read auth. */
export async function hydrateSessionFromAppData(): Promise<void> {
  if (!isTauri()) return;
  try {
    const invoke = await getInvoke();
    const json = await invoke<string>("load_session");
    if (!json) return;
    const blob = JSON.parse(json) as Record<string, string>;
    let restored = 0;
    for (const k of KEYS) {
      if (localStorage.getItem(k) === null && typeof blob[k] === "string") {
        localStorage.setItem(k, blob[k]);
        restored++;
      }
    }
    if (restored > 0) {
      console.log(`[Sion][session] restored ${restored} key(s) from app-data (CEF profile was reset)`);
    }
  } catch {
    /* best-effort */
  }
}

// The auth keys re-mirror on their own write paths (saveCredentials / device-id
// write). Settings change frequently and have no such hook, so subscribe to the
// settings store and re-mirror on change, debounced to avoid hammering the IPC.
let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
export function startSettingsMirror(): void {
  if (!isTauri()) return;
  import("../stores/useSettingsStore").then(({ useSettingsStore }) => {
    useSettingsStore.subscribe(() => {
      if (mirrorTimer) clearTimeout(mirrorTimer);
      mirrorTimer = setTimeout(() => { mirrorTimer = null; void mirrorSessionToAppData(); }, 1500);
    });
  }).catch(() => { /* best-effort */ });
}
