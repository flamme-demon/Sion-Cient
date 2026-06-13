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

import { useSettingsStore, type VoiceSoundCfg } from "../stores/useSettingsStore";
import { useAppStore } from "../stores/useAppStore";
import { getSharedAudioContext } from "./audioContext";

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

/** User override (custom file, trimmed + gain) for a cue, or null for default. */
function overrideFor(cue: Cue): VoiceSoundCfg | null {
  const cfg = useSettingsStore.getState().voiceSounds[cue];
  return cfg && typeof cfg === "object" && cfg.path ? cfg : null;
}

// ---- custom cue (picked file, trimmed + gain) ----------------------------

// Custom files live outside the bundle; CEF can't `new Audio()` a raw file://
// path, so Rust reads the bytes (read_file_b64) and we decode + cache an
// AudioBuffer per path. Playback uses Web Audio so we can play just the
// trimmed [start,end] region at the configured gain.
const bufferCache = new Map<string, AudioBuffer>();
async function bufferForPath(path: string): Promise<AudioBuffer | null> {
  const cached = bufferCache.get(path);
  if (cached) return cached;
  const ac = audioCtx();
  if (!ac) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const b64 = await invoke<string>("read_file_b64", { path });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = await ac.decodeAudioData(bytes.buffer);
    bufferCache.set(path, buf);
    return buf;
  } catch {
    return null;
  }
}

async function playCustom(cfg: VoiceSoundCfg): Promise<boolean> {
  const ac = audioCtx();
  if (!ac) return false;
  const buf = await bufferForPath(cfg.path);
  if (!buf) return false;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const g = ac.createGain();
  g.gain.value = Math.max(0, cfg.gain);
  src.connect(g);
  g.connect(ac.destination);
  const start = Math.max(0, Math.min(cfg.start, buf.duration));
  const dur = Math.max(0, Math.min(cfg.end, buf.duration) - start);
  src.start(0, start, dur > 0 ? dur : undefined);
  return true;
}

// ---- bundled default file playback ---------------------------------------

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

function audioCtx(): AudioContext | null {
  try {
    const ac = getSharedAudioContext();
    if (ac.state === "suspended") void ac.resume();
    return ac;
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
  // Attention fanfare (matches the old soundService.playPoke character).
  poke: () => playSequence(
    [{ freq: 523.25, start: 0, dur: 0.1 }, { freq: 659.25, start: 0.09, dur: 0.1 }, { freq: 783.99, start: 0.18, dur: 0.22 }],
    "sawtooth", 0.12),
  // You got kicked — harsh descending buzz.
  kick: () => playSequence(
    [{ freq: 392, start: 0, dur: 0.12 }, { freq: 311.13, start: 0.11, dur: 0.12 }, { freq: 196, start: 0.22, dur: 0.22 }],
    "sawtooth", 0.18),
  // Someone in your channel got kicked — short neutral two-tone (witnesses).
  memberKicked: () => playSequence(
    [{ freq: 466.16, start: 0, dur: 0.09 }, { freq: 349.23, start: 0.1, dur: 0.14 }], "triangle", SYNTH_PEAK),
  // Local action feedback — descending = off, ascending = on (ported from the
  // old soundService dual-tones).
  mute: () => playSequence(
    [{ freq: 480, start: 0, dur: 0.1 }, { freq: 320, start: 0.06, dur: 0.1 }], "sine", SYNTH_PEAK),
  unmute: () => playSequence(
    [{ freq: 320, start: 0, dur: 0.1 }, { freq: 480, start: 0.06, dur: 0.1 }], "sine", SYNTH_PEAK),
  deafen: () => playSequence(
    [{ freq: 400, start: 0, dur: 0.12 }, { freq: 250, start: 0.08, dur: 0.12 }], "sine", SYNTH_PEAK),
  undeafen: () => playSequence(
    [{ freq: 250, start: 0, dur: 0.12 }, { freq: 400, start: 0.08, dur: 0.12 }], "sine", SYNTH_PEAK),
};

// ---- cue dispatch --------------------------------------------------------

type Cue =
  | "join" | "leave" | "timeout"
  | "poke" | "kick" | "memberKicked"
  | "mute" | "unmute" | "deafen" | "undeafen";

// Cues gated by the "voice channel sounds" toggle (ambient join/leave). The
// rest (poke/kick/memberKicked) are user-event notifications that always play.
const GATED: ReadonlySet<Cue> = new Set<Cue>(["join", "leave", "timeout"]);

// Local action-feedback cues (confirm the user's OWN mute/deafen toggle). These
// always play AND are never silenced by `muteSoundsWhenDeafened` — otherwise the
// "deafen" confirmation itself would be swallowed the instant you deafen.
const ACTION_FEEDBACK: ReadonlySet<Cue> = new Set<Cue>(["mute", "unmute", "deafen", "undeafen"]);

function playDefault(cue: Cue) {
  const url = fileFor(cue);
  if (url && playFile(url)) return;
  SYNTH[cue]();
}

function play(cue: Cue) {
  if (GATED.has(cue) && !ENABLED()) return;
  // Opt-in: silence every cue while deafened. Off by default — most users like
  // still hearing who joins even while deafened. Action-feedback cues are exempt
  // (you must hear your own mute/deafen confirmation).
  const s = useSettingsStore.getState();
  if (!ACTION_FEEDBACK.has(cue) && s.muteSoundsWhenDeafened && useAppStore.getState().isDeafened) return;
  const custom = overrideFor(cue);
  if (custom) {
    void playCustom(custom).then((ok) => { if (!ok) playDefault(cue); }); // custom failed → fall back
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

// LiveKit can fire ParticipantDisconnected twice for the same peer (most often
// after a watchdog-triggered `simulateScenario('full-reconnect')` re-emits the
// disconnect for a peer that's already gone). The first call consumes the
// `lost` flag and plays `timeout`; the second, with the flag cleared, played
// `leave` on top — hence the reported "timeout + leave" double. Dedup by
// identity within a short window so only the first cue plays.
const LEAVE_DEDUP_MS = 2500;
const recentLeaves = new Map<string, number>();

// Matrix user IDs we just saw kicked from our voice channel. Their imminent
// LiveKit disconnect must NOT also play a leave/timeout cue — the kick cue
// (kick / memberKicked) already covered the departure.
const KICK_SUPPRESS_MS = 5000;
const recentlyKicked = new Map<string, number>();

/** Record that `mxid` was just voice-kicked, so its LiveKit departure stays
 *  silent (the kick cue speaks for it). Called from the kick event handler. */
export function noteKicked(mxid: string) {
  recentlyKicked.set(mxid, Date.now());
}

// The rtc-backend identity is `@user:server` + suffix; extract the bare mxid.
function mxidOf(identity: string): string | null {
  return identity.match(/^(@[^:]+:[^:]+)/)?.[1] ?? null;
}

function wasRecentlyKicked(identity: string): boolean {
  const mxid = mxidOf(identity);
  if (!mxid) return false;
  const ts = recentlyKicked.get(mxid);
  if (ts == null) return false;
  recentlyKicked.delete(mxid);
  return Date.now() - ts < KICK_SUPPRESS_MS;
}

/** Clear tracked state — call when the local user leaves the room. */
export function resetVoiceCues() {
  lostPeers.clear();
  recentLeaves.clear();
  recentlyKicked.clear();
}

export function playJoinCue() {
  play("join");
}

/** You received a poke. Always plays (customizable), independent of the
 *  join/leave cue toggle. */
export function playPokeCue() {
  play("poke");
}

/** You were voice-kicked from a channel. */
export function playKickCue() {
  play("kick");
}

/** Someone else in your current voice channel was kicked — so witnesses know. */
export function playMemberKickedCue() {
  play("memberKicked");
}

// Local action-feedback (your own mic mute / deafen toggle). Always play,
// customizable, never silenced by deafen. Replace the old soundService beeps.
export function playMuteCue() {
  play("mute");
}
export function playUnmuteCue() {
  play("unmute");
}
export function playDeafenCue() {
  play("deafen");
}
export function playUndeafenCue() {
  play("undeafen");
}

/** Play a cue on demand (Settings preview button). Respects the enabled
 *  toggle so the preview matches what you'll actually hear. */
export function previewCue(cue: Cue) {
  play(cue);
}

export function onParticipantLeft(identity: string) {
  const now = Date.now();
  const prev = recentLeaves.get(identity);
  if (prev != null && now - prev < LEAVE_DEDUP_MS) {
    // Duplicate ParticipantDisconnected — first call already played the cue.
    lostPeers.delete(identity);
    return;
  }
  recentLeaves.set(identity, now);
  const timedOut = lostPeers.delete(identity);
  // A kicked peer's departure is already announced by the kick cue.
  if (wasRecentlyKicked(identity)) return;
  play(timedOut ? "timeout" : "leave");
}
