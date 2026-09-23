import { Filter, Direction } from "matrix-js-sdk";
import { getSharedAudioContext } from "./audioContext";
import { getMatrixClient, findSoundboardRoom, uploadFile } from "./matrixService";
import { voiceNativePublishData, extendVoiceNativeSoundboardBadge, bytesToB64 } from "./voiceNativeService";
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

export async function fetchSoundboardMessages(
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

const blobCache = new Map<string, string>(); // mxc -> blob URL (LRU borné)

/** Plafond du cache de sons. Chaque entrée retient les OCTETS du fichier
 *  (pas seulement une URL) : une soundboard de 200 sons écoutés finissait par
 *  garder des centaines de mégaoctets pour rien. Au-delà, on révoque l'entrée
 *  la plus ancienne — un son rejoué se re-télécharge, coût négligeable. */
const BLOB_CACHE_MAX = 24;

async function resolveBlobUrl(mxcUrl: string): Promise<string> {
  const cached = blobCache.get(mxcUrl);
  if (cached) {
    // Coup de jeune LRU : l'entrée redevient la plus récente.
    blobCache.delete(mxcUrl);
    blobCache.set(mxcUrl, cached);
    return cached;
  }
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
  // Éviction LRU : la plus ancienne sort, son URL est révoquée.
  while (blobCache.size > BLOB_CACHE_MAX) {
    const oldest = blobCache.keys().next().value;
    if (oldest === undefined || oldest === mxcUrl) break;
    const old = blobCache.get(oldest);
    blobCache.delete(oldest);
    if (old) URL.revokeObjectURL(old);
  }
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

/** Décodage PCM 48 kHz mono pour le chemin natif, converti une fois pour
 *  toutes au format de rendu. Le rééchantillonnage linéaire suffit : les clips
 *  sont bornés à 20 s et WebRTC reçoit le PCM final sans flux IPC temps réel.
 *  Retourne aussi la durée réellement décodée (ms), seule vérité disponible
 *  quand la métadonnée Matrix du son est absente ou fausse. Exporté pour que
 *  les cues de retour d'action (micro) empruntent le même chemin que la
 *  soundboard en appel. */
export async function decodeNativeSoundboardPcm(url: string): Promise<{ pcmB64: string; durationMs: number | null }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Sound decode failed: ${response.status}`);
  const encoded = await response.arrayBuffer();
  const decoded = await getSharedAudioContext().decodeAudioData(encoded);
  const outputLength = Math.ceil(decoded.length * 48_000 / decoded.sampleRate);
  const bytes = new Uint8Array(outputLength * 2);
  const channels = Array.from(
    { length: decoded.numberOfChannels },
    (_, channel) => decoded.getChannelData(channel),
  );
  for (let i = 0; i < outputLength; i++) {
    const position = i * decoded.sampleRate / 48_000;
    const left = Math.min(Math.floor(position), decoded.length - 1);
    const right = Math.min(left + 1, decoded.length - 1);
    const fraction = position - left;
    let sample = 0;
    for (const channel of channels) {
      sample += channel[left] + (channel[right] - channel[left]) * fraction;
    }
    sample = Math.max(-1, Math.min(1, sample / channels.length));
    const pcm = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    bytes[i * 2] = pcm & 0xff;
    bytes[i * 2 + 1] = (pcm >> 8) & 0xff;
  }
  const { bytesToB64 } = await import("./voiceNativeService");
  return {
    pcmB64: bytesToB64(bytes),
    durationMs: Number.isFinite(decoded.duration) ? Math.round(decoded.duration * 1000) : null,
  };
}

async function playSoundNative(url: string, gain: number): Promise<number | null> {
  const { playVoiceNativeSoundboard } = await import("./voiceNativeService");
  const { pcmB64, durationMs } = await decodeNativeSoundboardPcm(url);
  await playVoiceNativeSoundboard(pcmB64, playbackVolume * clampGain(gain));
  return durationMs;
}

/** Build the playback chain for one HTMLAudioElement and start playback.
 *  Web Audio is needed (vs `audio.volume`) because element volume is
 *  capped at 1.0 — boosting beyond that requires a GainNode. The
 *  DynamicsCompressor at the tail prevents loud clipping when a user pushes
 *  the gain too high. Cleanup is wired to `ended`/`error` of the element. */
async function playElementWithGain(audio: HTMLAudioElement, gain: number, onCleanup?: () => void): Promise<number | null> {
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
  // Durée réelle du média une fois les métadonnées lues (null si le conteneur
  // ne l'expose pas — flux infini, webm sans en-tête).
  return Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null;
}

/** Plays the sound locally with the per-sound gain applied. Used both for
 *  user-initiated plays and for handling remote broadcasts.
 *
 *  Retourne la durée réellement lue (ms), ou `null` si elle n'est pas
 *  mesurable — les appelants s'en servent pour diffuser un payload honnête et
 *  pour caler l'échéance du badge sur la lecture, pas sur l'arrivée du paquet. */
export async function playSoundLocal(mxcUrl: string, gain: number = 1.0): Promise<number | null> {
  // Respect the deafen state — if the user is sourdine, they don't want to
  // hear anything, including their own soundboard triggers. Broadcast still
  // happens independently so other participants hear it.
  if (useAppStore.getState().isDeafened) return null;

  const url = await resolveBlobUrl(mxcUrl);
  // En appel, le clip est mixé par le moteur Rust dans le rendu WebRTC (donc
  // aussi dans la référence AEC). Hors appel, lecture locale DOM classique.
  if (useAppStore.getState().connectedVoiceChannel) {
    return playSoundNative(url, gain);
  }
  // Attach to the DOM so the webview doesn't GC the element mid-play (which
  // manifests as AbortError: "media was removed from the document").
  const audio = document.createElement("audio");
  audio.src = url;
  audio.style.display = "none";
  audio.preload = "auto";
  document.body.appendChild(audio);
  return playElementWithGain(audio, gain);
}

const afkEncoder = new TextEncoder();
const afkDecoder = new TextDecoder();

/** Repli quand la durée du son n'est pas connue (sonde d'upload en échec,
 *  métadonnée absente) — miroir de `BADGE_DEFAULT_MS` côté Rust. */
export const SOUNDBOARD_BADGE_DEFAULT_MS = 3_000;
/** Plafond de sécurité : une durée aberrante ne doit pas figer un rond pour
 *  la session — miroir de `BADGE_MAX_MS` côté Rust. */
export const SOUNDBOARD_BADGE_MAX_MS = 60_000;

/** Normalise la durée annoncée dans un payload de badge : 0/absente → repli,
 *  au-delà du plafond → plafond. Miroir JS de `sane_badge_ms` (voice_native.rs). */
export function resolveBadgeDurationMs(durationMs: number | null | undefined): number {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return SOUNDBOARD_BADGE_DEFAULT_MS;
  }
  return Math.min(Math.round(durationMs), SOUNDBOARD_BADGE_MAX_MS);
}

/**
 * Broadcasts a play command to all participants in the currently connected
 * LiveKit voice channel. Does nothing if not connected.
 * Remote peers decide whether to play based on their own settings.
 *
 * The payload carries the emoji (fallback "🔊") and duration so receivers can
 * render a "now playing" badge on the sender's avatar without having to
 * resolve the sound from their local soundboard cache first.
 *
 * `durationMs` doit être la durée **réellement lue** (`playSoundLocal` la
 * renvoie) : la métadonnée Matrix peut manquer ou être fausse, et c'est elle
 * qui décide de la fin du rond chez tout le monde.
 */
export function broadcastSound(mxcUrl: string, emoji: string | null, durationMs: number | null, gain: number = 1.0): void {
  const resolvedEmoji = emoji || "🔊";
  const resolvedDuration = resolveBadgeDurationMs(durationMs);
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
  // Moteur Rust : `voice_native_publish_data`. Le badge local est posé côté
  // Rust (le data-channel ne revient pas vers l'expéditeur).
  voiceNativePublishData(AFK_LIKE_TOPIC, bytesToB64(payload)).catch((err) => {
    console.warn("[Sion] soundboard broadcast natif failed:", err);
  });
}

export const SOUNDBOARD_TOPIC = AFK_LIKE_TOPIC;

/**
 * Handles a data-channel payload for the soundboard topic. Called by le
 * relais data-channel natif (`useLiveKit` → `voice-native-data`).
 *
 * Le badge est posé par le Rust à l'arrivée du paquet, donc **avant** que ce
 * client n'ait téléchargé, décodé et mis en file le clip : on repousse
 * l'échéance sur la durée réellement mesurée au démarrage de la lecture, pour
 * que le rond finisse avec le son et pas avec la latence de démarrage.
 */
export async function handleRemoteBroadcast(payload: Uint8Array, senderIdentity: string): Promise<void> {
  try {
    const data = JSON.parse(afkDecoder.decode(payload)) as { mxc?: string; emoji?: string; duration?: number; gain?: number };
    if (!data.mxc) return;
    // Le badge "now playing" est posé par le moteur Rust à la réception.
    const { useSettingsStore } = await import("../stores/useSettingsStore");
    if (!useSettingsStore.getState().soundboardEnabled) return;
    // Older senders may not include `gain` — default to 1.0 (no boost).
    const measuredMs = await playSoundLocal(data.mxc, typeof data.gain === "number" ? data.gain : 1.0);
    if (senderIdentity) {
      await extendVoiceNativeSoundboardBadge(
        senderIdentity,
        resolveBadgeDurationMs(measuredMs ?? data.duration),
        data.emoji || "🔊",
      ).catch(() => { /* badge best-effort : la lecture, elle, a réussi */ });
    }
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
    // Reuse the shared context (les webviews plafonnent les AudioContexts concurrents) —
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
