import { getMatrixClient, findSoundboardRoom, uploadFile } from "./matrixService";
import { getCurrentRoom, setPlayingSound } from "./livekitService";
import { useAppStore } from "../stores/useAppStore";

export interface SoundEntry {
  eventId: string;
  mxcUrl: string;
  label: string;
  category: string;
  emoji: string | null;
  body: string;
  mimetype: string;
  size: number;
  duration: number | null;
  senderId: string;
  timestamp: number;
  /** Per-sound gain multiplier (1.0 = original level, 2.0 = +6 dB, etc.).
   *  Stored in the Matrix metadata so every viewer applies the same boost.
   *  Defaults to 1.0 for sounds uploaded before this field existed. */
  gain: number;
}

export const SOUNDBOARD_MAX_FILE_SIZE = 1024 * 1024; // 1 MB
export const SOUNDBOARD_MAX_DURATION_MS = 20_000; // 20s
const AFK_LIKE_TOPIC = "sion-soundboard"; // data-channel topic for broadcasts

// Custom field namespace in m.audio content
const SB_NAMESPACE = "com.sion.soundboard";

type RawContent = {
  msgtype?: string;
  body?: string;
  url?: string;
  info?: { size?: number; mimetype?: string; duration?: number };
  [SB_NAMESPACE]?: { label?: string; category?: string; emoji?: string; gain?: number };
};

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function normalizeCategory(raw: string | undefined): string {
  if (!raw) return "Autre";
  const trimmed = raw.split("/").map((s) => s.trim()).filter(Boolean).join("/");
  return trimmed || "Autre";
}

function parseSound(ev: {
  getId: () => string | undefined;
  getContent: () => RawContent;
  getSender: () => string | null;
  getTs: () => number;
}): SoundEntry | null {
  const id = ev.getId();
  if (!id) return null;
  const content = ev.getContent();
  if (content.msgtype !== "m.audio") return null;
  const url = content.url;
  if (!url || !url.startsWith("mxc://")) return null;
  const meta = content[SB_NAMESPACE] || {};
  const body = content.body || "sound";
  // Clamp gain to a sane range — the slider exposes 0–3 but rogue events
  // could carry anything. NaN/missing falls back to 1.0 (no change).
  const rawGain = typeof meta.gain === "number" && Number.isFinite(meta.gain) ? meta.gain : 1.0;
  const gain = Math.max(0, Math.min(5, rawGain));
  return {
    eventId: id,
    mxcUrl: url,
    label: meta.label || stripExtension(body),
    category: normalizeCategory(meta.category),
    emoji: meta.emoji || null,
    body,
    mimetype: content.info?.mimetype || "audio/mpeg",
    size: content.info?.size || 0,
    duration: content.info?.duration ?? null,
    senderId: ev.getSender() || "",
    timestamp: ev.getTs() || 0,
    gain,
  };
}

/**
 * Returns all sound entries from the soundboard room. Because the soundboard
 * room is hidden from the sidebar and never "active", its timeline may only
 * contain recent sync events — older sounds won't be cached yet. We force a
 * `scrollback()` on first load to backfill the timeline with historical
 * `m.audio` messages.
 */
export async function listSounds(): Promise<SoundEntry[]> {
  const client = getMatrixClient();
  if (!client) return [];
  const roomId = await findSoundboardRoom();
  if (!roomId) return [];
  const room = client.getRoom(roomId);
  if (!room) return [];

  // Backfill older history (up to 200 events) so sounds uploaded before this
  // session are surfaced too. scrollback is a no-op if we've already hit the
  // start of the timeline.
  try {
    await client.scrollback(room, 200);
  } catch (err) {
    console.warn("[Sion] soundboard scrollback failed:", err);
  }

  const events = room.getLiveTimeline().getEvents();

  // First pass — collect original m.audio events (not edits themselves).
  const sounds: SoundEntry[] = [];
  for (const ev of events) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (ev as any).getContent?.() as RawContent | undefined;
    if (!content) continue;
    // Skip replacement events — they should not be treated as standalone entries.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relates = (content as any)["m.relates_to"];
    if (relates?.rel_type === "m.replace") continue;
    const s = parseSound(ev as never);
    if (s) sounds.push(s);
  }

  // Second pass — overlay metadata from the latest edit (if any).
  const editByOriginal = new Map<string, { meta: RawContent[typeof SB_NAMESPACE]; body: string; ts: number }>();
  for (const ev of events) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (ev as any).getContent?.() as RawContent | undefined;
    if (!content) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relates = (content as any)["m.relates_to"];
    if (relates?.rel_type !== "m.replace" || !relates?.event_id) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newContent = (content as any)["m.new_content"] as RawContent | undefined;
    if (!newContent) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ts = (ev as any).getTs?.() || 0;
    const existing = editByOriginal.get(relates.event_id);
    if (!existing || ts > existing.ts) {
      editByOriginal.set(relates.event_id, {
        meta: newContent[SB_NAMESPACE],
        body: newContent.body || "",
        ts,
      });
    }
  }
  for (const s of sounds) {
    const edit = editByOriginal.get(s.eventId);
    if (!edit) continue;
    if (edit.meta?.label) s.label = edit.meta.label;
    if (edit.meta?.category) s.category = normalizeCategory(edit.meta.category);
    if (edit.meta && "emoji" in edit.meta) s.emoji = edit.meta.emoji || null;
    // Apply gain edits too — without this, editing a sound to gain=3.0
    // sends the m.replace correctly but the next listSounds() drops back
    // to the original event's value (typically 1.0), so the boost never
    // reaches playback. Treat absent `gain` as "reset to 1.0" so removing
    // the boost in a later edit also propagates.
    if (edit.meta && "gain" in edit.meta) {
      const g = typeof edit.meta.gain === "number" && Number.isFinite(edit.meta.gain) ? edit.meta.gain : 1.0;
      s.gain = Math.max(0, Math.min(5, g));
    } else if (edit.meta) {
      // Edit present but `gain` field absent → user reset to default.
      s.gain = 1.0;
    }
  }

  return sounds.sort((a, b) => b.timestamp - a.timestamp);
}

export async function getSoundboardRoomId(): Promise<string | null> {
  return findSoundboardRoom();
}

/**
 * Uploads a sound file + sends the m.audio message with custom soundboard
 * metadata. Returns the Matrix event id of the sent message.
 */
export async function uploadSound(
  file: File,
  label: string,
  category: string,
  emoji: string | null,
  gain: number = 1.0,
): Promise<string> {
  const client = getMatrixClient();
  if (!client) throw new Error("Matrix client not initialized");
  const roomId = await findSoundboardRoom();
  if (!roomId) throw new Error("Soundboard room not created yet");
  if (file.size > SOUNDBOARD_MAX_FILE_SIZE) {
    throw new Error(`Fichier trop lourd (max ${Math.round(SOUNDBOARD_MAX_FILE_SIZE / 1024)} KB)`);
  }
  if (!file.type.startsWith("audio/")) {
    throw new Error("Le fichier doit être un audio");
  }
  const duration = await probeDuration(file).catch(() => null);
  if (duration !== null && duration > SOUNDBOARD_MAX_DURATION_MS) {
    throw new Error(`Son trop long (max ${Math.round(SOUNDBOARD_MAX_DURATION_MS / 1000)}s)`);
  }
  const mxcUrl = await uploadFile(file);
  const content: Record<string, unknown> = {
    msgtype: "m.audio",
    body: file.name,
    url: mxcUrl,
    info: {
      mimetype: file.type,
      size: file.size,
      ...(duration !== null ? { duration } : {}),
    },
    [SB_NAMESPACE]: {
      label: label.trim().slice(0, 60) || stripExtension(file.name),
      category: normalizeCategory(category),
      ...(emoji ? { emoji } : {}),
      // Only persist the gain if it deviates from default — keeps legacy
      // payloads bit-identical and avoids polluting the event with no-op
      // fields. parseSound falls back to 1.0 when the field is absent.
      ...(gain !== 1.0 ? { gain: clampGain(gain) } : {}),
    },
  };
  const res = await client.sendMessage(roomId, content as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (res as any).event_id as string;
}

function probeDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      // Matrix requires an integer for info.duration (js_int::Int). Float
      // durations (2384.5ms) get rejected with M_BAD_JSON.
      resolve(Math.round(audio.duration * 1000));
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not probe audio"));
    };
    audio.src = url;
  });
}

// ---- Playback ----

const blobCache = new Map<string, string>(); // mxc -> blob URL

async function resolveBlobUrl(mxcUrl: string): Promise<string> {
  const cached = blobCache.get(mxcUrl);
  if (cached) return cached;
  const client = getMatrixClient();
  if (!client) throw new Error("Matrix client not initialized");
  const httpUrl = client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, true, true, true);
  if (!httpUrl) throw new Error("Cannot resolve mxc URL");
  // Matrix v1.11+ authenticated media endpoint (_matrix/client/v1/media/*)
  // requires a Bearer token, unlike the legacy _matrix/media/* endpoints.
  const token = client.getAccessToken();
  const res = await fetch(httpUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  blobCache.set(mxcUrl, blobUrl);
  return blobUrl;
}

export function invalidateSoundCache(mxcUrl: string): void {
  const cached = blobCache.get(mxcUrl);
  if (cached) {
    URL.revokeObjectURL(cached);
    blobCache.delete(mxcUrl);
  }
}

/**
 * Edits a sound's metadata (label/category/emoji) by sending an m.replace
 * event. The original event id is preserved so hotkey bindings remain valid.
 */
export async function editSound(
  original: SoundEntry,
  label: string,
  category: string,
  emoji: string | null,
  gain: number = original.gain,
): Promise<void> {
  const client = getMatrixClient();
  if (!client) throw new Error("Matrix client not initialized");
  const roomId = await findSoundboardRoom();
  if (!roomId) throw new Error("Soundboard room not created");

  const clamped = clampGain(gain);
  const newMeta = {
    label: label.trim().slice(0, 60) || original.label,
    category: normalizeCategory(category),
    ...(emoji ? { emoji } : {}),
    ...(clamped !== 1.0 ? { gain: clamped } : {}),
  };

  // m.replace edit — keep the same url/info/body, only patch the com.sion field.
  const newContent: Record<string, unknown> = {
    msgtype: "m.audio",
    body: original.body,
    url: original.mxcUrl,
    info: {
      mimetype: original.mimetype,
      size: original.size,
      ...(original.duration !== null ? { duration: original.duration } : {}),
    },
    [SB_NAMESPACE]: newMeta,
    "m.new_content": {
      msgtype: "m.audio",
      body: original.body,
      url: original.mxcUrl,
      info: {
        mimetype: original.mimetype,
        size: original.size,
        ...(original.duration !== null ? { duration: original.duration } : {}),
      },
      [SB_NAMESPACE]: newMeta,
    },
    "m.relates_to": {
      rel_type: "m.replace",
      event_id: original.eventId,
    },
  };

  await client.sendMessage(roomId, newContent as never);
}

export async function deleteSound(eventId: string): Promise<void> {
  const client = getMatrixClient();
  if (!client) throw new Error("Matrix client not initialized");
  const roomId = await findSoundboardRoom();
  if (!roomId) throw new Error("Soundboard room not created");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (client as any).redactEvent(roomId, eventId);
}

let playbackVolume = 0.2;
export function setPlaybackVolume(v: number) {
  playbackVolume = Math.max(0, Math.min(1, v));
}

/** Allowed range for the per-sound gain multiplier. 0–3 covers "mute" up to
 *  +9.5 dB, which is enough headroom for very quiet uploads while staying
 *  safe with the limiter behind it. */
export const SOUND_GAIN_MIN = 0;
export const SOUND_GAIN_MAX = 3;
export const SOUND_GAIN_DEFAULT = 1;
function clampGain(v: number): number {
  if (!Number.isFinite(v)) return SOUND_GAIN_DEFAULT;
  return Math.max(SOUND_GAIN_MIN, Math.min(SOUND_GAIN_MAX, v));
}

// Lazy-created shared AudioContext. Browsers cap the number of concurrent
// AudioContexts (~6) so we reuse one across every soundboard play. Created
// on first playback (after a user gesture) so autoplay policy is satisfied.
let sharedAudioContext: AudioContext | null = null;
function getSharedAudioContext(): AudioContext {
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    sharedAudioContext = new Ctor();
  }
  return sharedAudioContext;
}

/** Build the playback chain for one HTMLAudioElement and start playback.
 *  Web Audio is needed (vs `audio.volume`) because element volume is
 *  capped at 1.0 — boosting beyond that requires a GainNode. The
 *  DynamicsCompressor at the tail prevents loud clipping when a user pushes
 *  the gain too high. Cleanup is wired to `ended`/`error` of the element. */
async function playElementWithGain(audio: HTMLAudioElement, gain: number, onCleanup?: () => void): Promise<void> {
  const ctx = getSharedAudioContext();
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch { /* fine — first play after gesture will resume */ }
  }
  let source: MediaElementAudioSourceNode;
  try {
    source = ctx.createMediaElementSource(audio);
  } catch (err) {
    // createMediaElementSource throws if called twice on the same element —
    // we always pass a freshly-created element, so this signals a real error.
    audio.remove();
    onCleanup?.();
    throw err;
  }
  const gainNode = ctx.createGain();
  gainNode.gain.value = playbackVolume * clampGain(gain);
  // Soft brick-wall to keep loud peaks from blowing out viewers' ears when
  // someone pushes the slider to 300 % on an already-loud sample.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;
  source.connect(gainNode);
  gainNode.connect(limiter);
  limiter.connect(ctx.destination);

  const cleanup = () => {
    try { source.disconnect(); } catch { /* */ }
    try { gainNode.disconnect(); } catch { /* */ }
    try { limiter.disconnect(); } catch { /* */ }
    audio.remove();
    onCleanup?.();
  };
  audio.addEventListener("ended", cleanup, { once: true });
  audio.addEventListener("error", cleanup, { once: true });

  try {
    await audio.play();
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Plays the sound locally with the per-sound gain applied. Used both for
 *  user-initiated plays and for handling remote broadcasts. */
export async function playSoundLocal(mxcUrl: string, gain: number = 1.0): Promise<void> {
  // Respect the deafen state — if the user is sourdine, they don't want to
  // hear anything, including their own soundboard triggers. Broadcast still
  // happens independently so other participants hear it.
  if (useAppStore.getState().isDeafened) return;

  const url = await resolveBlobUrl(mxcUrl);
  // Attach to the DOM so Chromium doesn't GC the element mid-play (which
  // manifests as AbortError: "media was removed from the document").
  const audio = document.createElement("audio");
  audio.src = url;
  audio.style.display = "none";
  audio.preload = "auto";
  document.body.appendChild(audio);
  await playElementWithGain(audio, gain);
}

/** Preview a sound from a local File (during upload) with the given gain.
 *  Used by the upload modal so the user can audition the effect of the
 *  gain slider before committing the upload. The blob URL is revoked on
 *  cleanup so we don't accumulate revoked-but-referenced blobs. */
export async function previewSoundFile(file: File, gain: number = 1.0): Promise<void> {
  if (useAppStore.getState().isDeafened) return;
  const url = URL.createObjectURL(file);
  const audio = document.createElement("audio");
  audio.src = url;
  audio.style.display = "none";
  audio.preload = "auto";
  document.body.appendChild(audio);
  await playElementWithGain(audio, gain, () => URL.revokeObjectURL(url));
}

const afkEncoder = new TextEncoder();
const afkDecoder = new TextDecoder();

/**
 * Broadcasts a play command to all participants in the currently connected
 * LiveKit voice channel. Does nothing if not connected.
 * Remote peers decide whether to play based on their own settings.
 *
 * The payload carries the emoji (fallback "🔊") and duration so receivers can
 * render a "now playing" badge on the sender's avatar without having to
 * resolve the sound from their local soundboard cache first.
 */
export function broadcastSound(mxcUrl: string, emoji: string | null, durationMs: number | null, gain: number = 1.0): void {
  const room = getCurrentRoom();
  if (!room) return;
  const resolvedEmoji = emoji || "🔊";
  const resolvedDuration = durationMs ?? 3000;
  // Local "now playing" badge on own avatar — mirrors what remote peers will
  // show when they receive the broadcast.
  setPlayingSound(room.localParticipant.identity, resolvedEmoji, resolvedDuration);
  try {
    const payload = afkEncoder.encode(JSON.stringify({
      mxc: mxcUrl,
      emoji: resolvedEmoji,
      duration: resolvedDuration,
      // Sender ships the gain so receivers don't need to look up the sound
      // metadata locally (avoids a race where the receiver hasn't synced
      // the latest m.replace edit yet). Defaults sender-side to the
      // SoundEntry.gain for the played sound.
      gain,
    }));
    room.localParticipant.publishData(payload, { reliable: true, topic: AFK_LIKE_TOPIC }).catch((err) => {
      console.warn("[Sion] soundboard broadcast failed:", err);
    });
  } catch (err) {
    console.warn("[Sion] soundboard publishData threw:", err);
  }
}

export const SOUNDBOARD_TOPIC = AFK_LIKE_TOPIC;

/**
 * Handles a data-channel payload for the soundboard topic. Called by the
 * LiveKit DataReceived listener in livekitService.
 */
export async function handleRemoteBroadcast(payload: Uint8Array, senderIdentity: string): Promise<void> {
  try {
    const data = JSON.parse(afkDecoder.decode(payload)) as { mxc?: string; emoji?: string; duration?: number; gain?: number };
    if (!data.mxc) return;
    // Badge always renders (independent of soundboardEnabled) — receivers
    // who disabled the soundboard still want to see who's triggering sounds.
    setPlayingSound(senderIdentity, data.emoji || "🔊", data.duration ?? 3000);
    const { useSettingsStore } = await import("../stores/useSettingsStore");
    if (!useSettingsStore.getState().soundboardEnabled) return;
    // Older senders may not include `gain` — default to 1.0 (no boost).
    await playSoundLocal(data.mxc, typeof data.gain === "number" ? data.gain : 1.0);
  } catch (err) {
    console.warn("[Sion] soundboard remote play failed:", err);
  }
}

/**
 * Plays a short error buzzer (used when a sound has been redacted).
 */
export function playErrorBuzzer(): void {
  if (useAppStore.getState().isDeafened) return;
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.25);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.4);
    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch { /* AudioContext not available */ }
}

/** Returns unique category paths present in the sound list (for UI). */
export function extractCategoryTree(sounds: SoundEntry[]): string[] {
  const set = new Set<string>();
  for (const s of sounds) set.add(s.category);
  return Array.from(set).sort();
}
