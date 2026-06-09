// TeamSpeak-style audio cues for the voice channel the local user is in:
// a sound when a member joins, another when they leave cleanly, and a distinct
// one when they drop (timeout / connection lost).
//
// Drop your own royalty-free sounds into `src/assets/sounds/` named
// `join`, `leave`, `timeout` (any of .ogg/.mp3/.wav/.m4a) and they're picked up
// automatically — see that folder's README for sources. Until a file is
// present for a given cue, a soft synthesized fallback plays so the feature
// isn't silent.
//
// "Quit vs timeout" can't be read from LiveKit's ParticipantDisconnected (the
// SDK discards the server's DisconnectReason). We infer it: a peer whose
// ConnectionQuality fell to `lost` right before disconnecting timed out; a
// clean leave never passes through `lost`. livekitService feeds us that signal
// via noteConnectionLost(); onParticipantLeft() reads + clears it.

import { useSettingsStore } from "../stores/useSettingsStore";

// User-supplied sound files, resolved at build time. Missing files are simply
// absent from the map (no build error) — the synth fallback covers them.
const soundFiles = import.meta.glob("../assets/sounds/*.{ogg,mp3,wav,m4a}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function fileFor(name: string): string | null {
  for (const [path, url] of Object.entries(soundFiles)) {
    const base = path.split("/").pop()?.replace(/\.[^.]+$/, "");
    if (base === name) return url;
  }
  return null;
}

const ENABLED = () => useSettingsStore.getState().voiceChannelSounds;
const FILE_VOLUME = 0.7;
const SYNTH_PEAK = 0.16;

/** User override path for a cue (Settings → "Parcourir"), or "" if none. */
function overrideFor(cue: Cue): string {
  const s = useSettingsStore.getState();
  return cue === "join" ? s.voiceSoundJoin : cue === "leave" ? s.voiceSoundLeave : s.voiceSoundTimeout;
}

// Custom files live outside the bundle; CEF can't `new Audio()` a raw file://
// path, so Rust reads the bytes (read_file_b64) and we cache a blob URL per
// path. Tiny files → load once, reuse.
const blobCache = new Map<string, string>();
async function blobForPath(path: string): Promise<string | null> {
  const cached = blobCache.get(path);
  if (cached) return cached;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const b64 = await invoke<string>("read_file_b64", { path });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes]));
    blobCache.set(path, url);
    return url;
  } catch {
    return null;
  }
}

// ---- file playback -------------------------------------------------------

function playFile(url: string): boolean {
  try {
    const a = new Audio(url);
    a.volume = FILE_VOLUME;
    void a.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ---- synthesized fallback ------------------------------------------------

let ctx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

interface Note { freq: number; start: number; dur: number }
function playSequence(notes: Note[], wave: OscillatorType, peak: number) {
  const ac = audioCtx();
  if (!ac) return;
  const t0 = ac.currentTime + 0.02;
  for (const n of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = wave;
    osc.frequency.value = n.freq;
    osc.connect(gain);
    gain.connect(ac.destination);
    const s = t0 + n.start;
    gain.gain.setValueAtTime(0.0001, s);
    gain.gain.linearRampToValueAtTime(peak, s + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, s + n.dur);
    osc.start(s);
    osc.stop(s + n.dur + 0.03);
  }
}

const SYNTH: Record<Cue, () => void> = {
  join: () => playSequence(
    [{ freq: 659.25, start: 0, dur: 0.1 }, { freq: 987.77, start: 0.09, dur: 0.13 }], "sine", SYNTH_PEAK),
  leave: () => playSequence(
    [{ freq: 987.77, start: 0, dur: 0.1 }, { freq: 659.25, start: 0.09, dur: 0.13 }], "sine", SYNTH_PEAK),
  timeout: () => playSequence(
    [{ freq: 440, start: 0, dur: 0.09 }, { freq: 349.23, start: 0.1, dur: 0.09 }, { freq: 261.63, start: 0.2, dur: 0.16 }],
    "triangle", SYNTH_PEAK),
};

// ---- cue dispatch --------------------------------------------------------

type Cue = "join" | "leave" | "timeout";

function playDefault(cue: Cue) {
  const url = fileFor(cue);
  if (url && playFile(url)) return;
  SYNTH[cue]();
}

function play(cue: Cue) {
  if (!ENABLED()) return;
  const custom = overrideFor(cue);
  if (custom) {
    void blobForPath(custom).then((url) => {
      if (!(url && playFile(url))) playDefault(cue); // custom failed → fall back
    });
    return;
  }
  playDefault(cue);
}

/** Peers whose connection was reported `lost` → treat their next disconnect
 *  as a timeout rather than a clean leave. Keyed by identity. */
const lostPeers = new Set<string>();

export function noteConnectionLost(identity: string, lost: boolean) {
  if (lost) lostPeers.add(identity);
  else lostPeers.delete(identity);
}

/** Clear tracked state — call when the local user leaves the room. */
export function resetVoiceCues() {
  lostPeers.clear();
}

export function playJoinCue() {
  play("join");
}

/** Play a cue on demand (Settings preview button). Respects the enabled
 *  toggle so the preview matches what you'll actually hear. */
export function previewCue(cue: Cue) {
  play(cue);
}

/** Drop a cached blob (call when the user changes/clears an override path so
 *  a re-picked file is reloaded). */
export function invalidateSoundCache(path: string) {
  const url = blobCache.get(path);
  if (url) { URL.revokeObjectURL(url); blobCache.delete(path); }
}

export function onParticipantLeft(identity: string) {
  const timedOut = lostPeers.delete(identity);
  play(timedOut ? "timeout" : "leave");
}
