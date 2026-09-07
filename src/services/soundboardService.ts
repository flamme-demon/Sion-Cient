import { Filter, Direction } from "matrix-js-sdk";
import { getSharedAudioContext } from "./audioContext";
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
  /** Voix de référence : transcription exacte de l'extrait. Les modèles qui
   *  l'exigent la retrouvent ainsi sans que l'utilisateur la ressaisisse. */
  refText: string | null;
  /** Voix de référence : portrait (mxc) affiché dans la galerie. */
  avatarUrl: string | null;
  /** "voice" = extrait de référence pour la synthèse, jamais listé parmi les
   *  sons jouables. Le nom de catégorie ne peut pas servir de marqueur : il est
   *  librement modifiable par l'utilisateur. */
  kind: "sound" | "voice";
  /** Modèle audio.cpp associé : celui retenu pour une voix de référence, celui
   *  qui a produit le clip pour un son généré. Purement informatif — la
   *  génération reste libre d'en employer un autre. Null pour tout ce qui a été
   *  publié avant l'existence du champ. */
  ttsModel: string | null;
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
  [SB_NAMESPACE]?: {
    label?: string;
    category?: string;
    emoji?: string;
    /** New format: gain stored as integer percentage (e.g. 240 = 2.40×).
     *  Required because Matrix enforces js_int on event values; a float
     *  multiplier (2.4) gets rejected with M_BAD_JSON. */
    gain_pct?: number;
    /** Transcription de l'extrait (voix de référence). */
    ref_text?: string;
    /** Portrait mxc de la voix. */
    avatar?: string;
    /** "voice" pour un extrait de référence TTS. */
    kind?: string;
    /** Identifiant du modèle audio.cpp associé, à titre informatif. */
    tts_model?: string;
    /** Legacy field from the v1.1.0 initial release — multiplier (1, 2, 3).
     *  Only round integer values landed (Matrix rejected floats), so when
     *  reading we treat any value here as a multiplier and prefer
     *  `gain_pct` if both are present. */
    gain?: number;
  };
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
  // Read gain — prefer the new `gain_pct` (int %) field, fall back to the
  // legacy `gain` multiplier from v1.1.0 for sounds uploaded before the
  // float-rejection fix.
  let gain = 1.0;
  if (typeof meta.gain_pct === "number" && Number.isFinite(meta.gain_pct)) {
    gain = meta.gain_pct / 100;
  } else if (typeof meta.gain === "number" && Number.isFinite(meta.gain)) {
    gain = meta.gain;
  }
  gain = Math.max(0, Math.min(5, gain));
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
    refText: meta.ref_text || null,
    avatarUrl: meta.avatar || null,
    // Repli sur la catégorie pour les voix enregistrées avant l'existence du
    // drapeau, sinon elles disparaîtraient de la galerie.
    kind: meta.kind === "voice" || normalizeCategory(meta.category) === "Voix" ? "voice" : "sound",
    ttsModel: meta.tts_model || null,
  };
}

// A reusable server-side filter that returns ONLY `m.room.message` events. The
// soundboard room's raw timeline is bloated with `m.room.member` (it invites
// every server user), `m.replace` edits and redactions — a plain
// `scrollback(200)` is diluted by that noise and, past a few hundred events,
// stops surfacing the oldest sounds. Paginating a FILTERED timeline fetches
// just the audio (+ edit) messages server-side: fewer bytes, faster parse, and
// complete regardless of how much membership churn the room has accumulated.
let sbFilter: Filter | null = null;

async function fetchSoundboardMessages(
  client: NonNullable<ReturnType<typeof getMatrixClient>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  room: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  try {
    if (!sbFilter) {
      sbFilter = new Filter(client.getUserId() || "");
      sbFilter.setDefinition({ room: { timeline: { types: ["m.room.message"], limit: 100 } } });
    }
    // Reusing the same Filter returns the same (cached) timeline set, so after
    // the first full back-pagination later calls find the token exhausted and
    // just re-read the accumulated events. New uploads arrive via sync.
    const timelineSet = room.getOrCreateFilteredTimelineSet(sbFilter, { prepopulateTimeline: true });
    const timeline = timelineSet.getLiveTimeline();
    let guard = 0;
    while (guard < 50 && timeline.getPaginationToken(Direction.Backward) !== null) {
      const more = await client.paginateEventTimeline(timeline, { backwards: true, limit: 100 });
      guard++;
      if (!more) break;
    }
    return timeline.getEvents();
  } catch (err) {
    // Fallback for servers/SDK paths where filtered pagination isn't available.
    console.warn("[Sion] soundboard filtered fetch failed, falling back to scrollback:", err);
    try { await client.scrollback(room, 400); } catch { /* ignore */ }
    return room.getLiveTimeline().getEvents();
  }
}

/**
 * Returns all sound entries from the soundboard room, fetched via a
 * message-only filtered pagination (see fetchSoundboardMessages).
 */
export async function listSounds(): Promise<SoundEntry[]> {
  const client = getMatrixClient();
  if (!client) return [];
  const roomId = await findSoundboardRoom();
  if (!roomId) return [];
  const room = client.getRoom(roomId);
  if (!room) return [];

  const events = await fetchSoundboardMessages(client, room);

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
    // Gain overlay — same prefer-new-fallback-legacy logic as parseSound.
    // An edit that omits both fields means the user reset to default 1.0.
    if (edit.meta && "gain_pct" in edit.meta) {
      const g = typeof edit.meta.gain_pct === "number" && Number.isFinite(edit.meta.gain_pct) ? edit.meta.gain_pct / 100 : 1.0;
      s.gain = Math.max(0, Math.min(5, g));
    } else if (edit.meta && "gain" in edit.meta) {
      const g = typeof edit.meta.gain === "number" && Number.isFinite(edit.meta.gain) ? edit.meta.gain : 1.0;
      s.gain = Math.max(0, Math.min(5, g));
    } else if (edit.meta) {
      s.gain = 1.0;
    }
    if (edit.meta && "ref_text" in edit.meta) s.refText = edit.meta.ref_text || null;
    if (edit.meta && "avatar" in edit.meta) s.avatarUrl = edit.meta.avatar || null;
    if (edit.meta && "tts_model" in edit.meta) s.ttsModel = edit.meta.tts_model || null;
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
  /** Renseigné pour un extrait de référence TTS : marque le son comme voix et
   *  porte ses métadonnées propres. */
  voice?: { refText?: string; avatar?: string },
  /** Modèle audio.cpp à mémoriser, pour une voix comme pour un son généré. */
  ttsModel?: string,
): Promise<{ eventId: string; mxcUrl: string; duration: number | null }> {
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
      // Persist gain only when it deviates from default. Stored as integer
      // percentage to satisfy Matrix's js_int constraint — a float gets
      // rejected with M_BAD_JSON.
      ...(gain !== 1.0 ? { gain_pct: Math.round(clampGain(gain) * 100) } : {}),
      ...(voice ? { kind: "voice" } : {}),
      ...(voice?.refText ? { ref_text: voice.refText } : {}),
      ...(voice?.avatar ? { avatar: voice.avatar } : {}),
      ...(ttsModel ? { tts_model: ttsModel } : {}),
    },
  };
  const res = await client.sendMessage(roomId, content as never);
  // L'URL mxc est renvoyée en plus de l'id : diffuser un son fraîchement
  // uploadé l'exige, et la retrouver via listSounds obligerait à attendre la
  // synchro de la room.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { eventId: (res as any).event_id as string, mxcUrl, duration };
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

/**
 * Récupère un son en File — utilisé par la génération de voix, qui doit
 * matérialiser l'extrait de référence sur disque pour le moteur audio.cpp.
 * Passe par le même cache de blobs que la lecture.
 */
export async function fetchSoundFile(entry: SoundEntry): Promise<File> {
  const url = await resolveBlobUrl(entry.mxcUrl);
  const blob = await (await fetch(url)).blob();
  const ext = entry.body.includes(".") ? entry.body.split(".").pop() : "ogg";
  return new File([blob], `ref.${ext}`, { type: entry.mimetype });
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
  /** Champs propres aux voix de référence. Omettre une clé la laisse
   *  inchangée ; la passer à null l'efface. */
  voice?: { refText?: string | null; avatar?: string | null },
): Promise<void> {
  const client = getMatrixClient();
  if (!client) throw new Error("Matrix client not initialized");
  const roomId = await findSoundboardRoom();
  if (!roomId) throw new Error("Soundboard room not created");

  const clamped = clampGain(gain);
  // Une édition est un remplacement : ce que newMeta omet, la relecture va le
  // chercher dans l'événement d'origine. D'où la reprise explicite de `kind` et
  // du modèle — sans elle, renommer une voix la rendrait à la soundboard, où
  // elle n'a rien à faire.
  const newMeta: Record<string, unknown> = {
    label: label.trim().slice(0, 60) || original.label,
    category: normalizeCategory(category),
    ...(emoji ? { emoji } : {}),
    // See uploadSound: gain_pct is an integer percentage to comply with
    // Matrix's js_int validation.
    ...(clamped !== 1.0 ? { gain_pct: Math.round(clamped * 100) } : {}),
    ...(original.kind === "voice" ? { kind: "voice" } : {}),
    ...(original.ttsModel ? { tts_model: original.ttsModel } : {}),
  };
  // `undefined` = ne pas toucher, `null` = effacer. Les distinguer impose de
  // tester la présence de la clé, pas sa véracité.
  if (voice && "refText" in voice) newMeta.ref_text = voice.refText || "";
  if (voice && "avatar" in voice) newMeta.avatar = voice.avatar || "";

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
  const resolvedEmoji = emoji || "🔊";
  const resolvedDuration = durationMs ?? 3000;
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
  // Chemin natif (chantier no-CEF) : pas de room JS, on passe par le moteur
  // Rust (`voice_native_publish_data`, reliable comme ici).
  if (!room) {
    import("./voiceNativeService").then(({ getActiveVoiceEngine, getVoiceNativeStatus, voiceNativePublishData, bytesToB64 }) => {
      if (getActiveVoiceEngine() !== "native") return;
      getVoiceNativeStatus().then((st) => {
        if (st.identity) setPlayingSound(st.identity, resolvedEmoji, resolvedDuration);
      }).catch(() => {});
      voiceNativePublishData(AFK_LIKE_TOPIC, bytesToB64(payload)).catch((err) => {
        console.warn("[Sion] soundboard broadcast natif failed:", err);
      });
    }).catch(() => {});
    return;
  }
  // Local "now playing" badge on own avatar — mirrors what remote peers will
  // show when they receive the broadcast.
  setPlayingSound(room.localParticipant.identity, resolvedEmoji, resolvedDuration);
  try {
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
    // Reuse the shared context (browsers/CEF cap concurrent AudioContexts) —
    // a per-call `new AudioContext()` risked hitting the cap and leaked when
    // start/stop threw before its close timer fired.
    const ctx = getSharedAudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.25);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.35);
    osc.connect(gain).connect(ctx.destination);
    // Detach from the shared destination once done so the nodes are GC'd.
    osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch { /* already gone */ } };
    osc.start(now);
    osc.stop(now + 0.4);
  } catch { /* AudioContext not available */ }
}
