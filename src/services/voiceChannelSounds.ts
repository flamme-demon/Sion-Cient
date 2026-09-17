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
// "Quit vs timeout" can't be read from the engine's participant-disconnected
// event (le SDK Rust ne remonte pas la raison). On l'infère : un pair dont la
// qualité est tombée à `lost` juste avant de disparaître a subi un timeout ;
// un départ propre ne passe jamais par `lost`. `useLiveKit` alimente ce signal
// via noteConnectionLost(); onParticipantLeft() lit puis efface.

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

// Custom files live outside the bundle; the webview can't read a raw file://
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

// Les assets du bundle sont servis via le schéma custom Tauri en production.
// WebKitGTK refuse ce schéma dans HTMLAudioElement, alors qu'il lit bien un
// `blob:`. Web Audio (`decodeAudioData`) semblait contourner le problème mais,
// une fois le moteur vocal natif ouvert, seul le premier MP3 était décodé ;
// tous les suivants (unmute/deafen/join/...) échouaient. On ne lui confie donc
// plus les fichiers embarqués : fetch → Blob URL → HTMLAudioElement.
const blobUrlCache = new Map<string, string>();
const playingFiles = new Set<HTMLAudioElement>();

async function blobUrlFor(url: string): Promise<string | null> {
  const cached = blobUrlCache.get(url);
  if (cached) return cached;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    blobUrlCache.set(url, blobUrl);
    return blobUrl;
  } catch (error) {
    console.error(`[Sion][cue] impossible de charger ${url}`, error);
    return null;
  }
}

/** Éléments audio déjà décodés, réutilisés d'un déclenchement à l'autre.
 *
 *  Un `new Audio()` par cue impose un cycle chargement + décodage avant que
 *  `play()` ne se résolve. Mesuré le 16/09 : environ une seconde entre l'appui
 *  sur F8 et le début du son, alors que l'URL blob était DÉJÀ en cache — ce
 *  n'est donc pas le téléchargement qui coûte, c'est le décodage, refait à
 *  chaque fois. Un élément déjà décodé redémarre en remettant `currentTime`
 *  à zéro, sans aucune latence.
 *
 *  Le petit bassin permet à deux déclenchements rapprochés de se superposer
 *  au lieu de se couper l'un l'autre. */
const audioPool = new Map<string, HTMLAudioElement[]>();
const AUDIO_POOL_MAX = 4;

function acquireAudio(blobUrl: string): HTMLAudioElement {
  const pool = audioPool.get(blobUrl);
  const free = pool?.find((element) => element.paused || element.ended);
  if (free) {
    // `currentTime` lève tant que le média n'est pas décodable ; dans ce cas
    // l'élément repart de zéro tout seul.
    try {
      free.currentTime = 0;
    } catch { /* pas encore prêt */ }
    return free;
  }
  const audio = new Audio(blobUrl);
  audio.preload = "auto";
  audio.volume = FILE_VOLUME;
  // Écouteurs posés UNE FOIS, à la création. Les attacher à chaque lecture —
  // même en `{ once: true }` — les accumulait sur un élément réutilisé : un
  // `once` ne se retire qu'en se déclenchant, or une lecture interrompue par
  // `stopActionCues()` n'émet jamais `ended`. Chaque cue coupé laissait donc
  // deux écouteurs derrière lui, indéfiniment.
  const release = () => playingFiles.delete(audio);
  audio.addEventListener("ended", release);
  audio.addEventListener("error", release);
  audio.addEventListener("pause", release);
  // `preload` amorce déjà le chargement ; `load()` ne fait que le forcer et
  // n'existe pas dans toutes les implémentations (mocks de test).
  try {
    audio.load?.();
  } catch { /* implémentation partielle */ }
  const next = pool ?? [];
  if (next.length < AUDIO_POOL_MAX) {
    next.push(audio);
    audioPool.set(blobUrl, next);
  }
  return audio;
}

/** Précharge et décode un cue sans le jouer, pour que le PREMIER appui soit
 *  aussi instantané que les suivants. */
export async function primeCue(url: string): Promise<void> {
  const playableUrl = await blobUrlFor(url);
  if (!playableUrl) return;
  acquireAudio(playableUrl);
}

async function playFile(url: string): Promise<boolean> {
  const playableUrl = await blobUrlFor(url);
  if (!playableUrl) return false;
  try {
    const audio = acquireAudio(playableUrl);
    audio.volume = FILE_VOLUME;
    playingFiles.add(audio);
    await audio.play();
    return true;
  } catch (error) {
    // `pause()` pendant un `play()` en attente rejette avec `AbortError` : la
    // lecture a été volontairement remplacée par un cue plus récent, ce n'est
    // pas un échec et surtout il ne faut pas jouer le timbre de repli.
    if (error instanceof DOMException && error.name === "AbortError") return true;
    console.error(`[Sion][cue] lecture du Blob refusée pour ${url}`, error);
    return false;
  }
}

/** Journalise l'exécution des cues côté Rust (visible dans les logs Tauri). */
async function logCue(message: string) {
  try {
    const { info } = await import("@tauri-apps/plugin-log");
    await info(`[cue] ${message}`);
  } catch { /* plugin absent */ }
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
async function playSequence(notes: Note[], wave: OscillatorType, peak: number) {
  const ac = audioCtx();
  if (!ac) return;
  // On attend la reprise du contexte avant de programmer : des oscillateurs
  // planifiés sur un contexte encore suspendu peuvent être perdus.
  if (ac.state !== "running") {
    try { await ac.resume(); } catch { /* geste requis */ }
  }
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

/** Cues que le moteur natif ne peut pas servir, quoi qu'il arrive.
 *
 *  `deafen` alimente le rendu WebRTC, que la sourdine rend justement silencieux
 *  à l'instant même où ce cue est joué : le clip y est accepté puis inaudible
 *  (constaté le 16/09). Il garde le chemin DOM, seul à contourner ce rendu, au
 *  prix de la latence de sortie de WebKit. */
const NEVER_NATIVE: ReadonlySet<Cue> = new Set<Cue>(["deafen"]);

/** Le chemin natif est-il utilisable pour ce cue, ici et maintenant ?
 *
 *  Hors appel, il n'existe pas. En sourdine, le moteur jette tout clip reçu —
 *  ce qui conviendrait aux retours d'action mais écraserait le réglage
 *  `muteSoundsWhenDeafened`, désactivé par défaut : l'utilisateur est censé
 *  continuer d'entendre les arrivées et départs en sourdine. On repasse donc
 *  par le DOM dans ce cas, qui applique ce réglage correctement. */
function nativePathUsable(cue: Cue): boolean {
  if (NEVER_NATIVE.has(cue)) return false;
  const app = useAppStore.getState();
  return !!app.connectedVoiceChannel && !app.isDeafened;
}

/** PCM déjà décodé, par cue : la lecture se réduit alors à un appel IPC. */
const nativePcmCache = new Map<Cue, string>();

async function nativePcmFor(cue: Cue): Promise<string | null> {
  const cached = nativePcmCache.get(cue);
  if (cached) return cached;
  const url = fileFor(cue);
  if (!url) return null;
  const { decodeNativeSoundboardPcm } = await import("./soundboardService");
  const { pcmB64 } = await decodeNativeSoundboardPcm(url);
  nativePcmCache.set(cue, pcmB64);
  return pcmB64;
}

/** Joue un retour d'action par le moteur Rust, comme le fait déjà la
 *  soundboard en appel.
 *
 *  En appel, l'ADM natif détient le périphérique et la sortie audio de WebKit
 *  attend : mesuré le 16/09, deux à trois secondes entre l'appel à `play()` —
 *  qui se résout pourtant immédiatement — et le son réellement audible. Assez
 *  pour que le son du mute se fasse entendre après le clic sur unmute, les deux
 *  se télescopant en ce qui s'entend comme un son joué deux fois. Le rendu natif
 *  ne souffre pas de cette attente, et le clip entre au passage dans la
 *  référence d'annulation d'écho. Lecture purement locale : rien n'est envoyé
 *  aux autres participants. */
async function playNativeAction(cue: Cue): Promise<boolean> {
  try {
    const pcm = await nativePcmFor(cue);
    if (!pcm) return false;
    const { playVoiceNativeSoundboard } = await import("./voiceNativeService");
    await playVoiceNativeSoundboard(pcm, FILE_VOLUME);
    return true;
  } catch (error) {
    console.warn(`[Sion][cue] chemin natif refusé pour ${cue}`, error);
    return false;
  }
}

function playDefault(cue: Cue) {
  if (nativePathUsable(cue)) {
    void playNativeAction(cue).then((ok) => {
      logCue(`${cue}: natif ${ok ? "joué" : "refusé → repli DOM"}`);
      if (!ok) playDomFile(cue);
    });
    return;
  }
  playDomFile(cue);
}

function playDomFile(cue: Cue) {
  const url = fileFor(cue);
  if (url) {
    // `HTMLAudioElement.play()` peut échouer (fichier absent du bundle,
    // décodage impossible, contexte occupé) : on retombe sur le timbre
    // synthétisé, joué par le contexte Web Audio partagé. Sans ce repli,
    // l'échec était avalé et la sourdine/unsourdine restait muette.
    void playFile(url).then((ok) => {
      logCue(`${cue}: fichier ${ok ? "joué" : "refusé → repli synthé"}`);
      if (!ok) SYNTH[cue]();
    });
    return;
  }
  logCue(`${cue}: aucun fichier, synthé`);
  SYNTH[cue]();
}

/** Coupe les retours d'action encore en cours (micro, sourdine).
 *
 *  Un cue peut démarrer avec plusieurs secondes de retard quand le sink audio
 *  est occupé par le stop/start de la capture. Sans cette coupure, le son du
 *  mute se faisait entendre APRÈS le clic sur unmute, et les deux s'enchaînaient
 *  — ce qui s'entend comme un son joué deux fois (constaté le 16/09). Le retour
 *  le plus récent est toujours le seul pertinent. */
function stopActionCues() {
  for (const cue of ACTION_FEEDBACK) {
    const source = fileFor(cue);
    if (!source) continue;
    const blobUrl = blobUrlCache.get(source);
    if (!blobUrl) continue;
    for (const element of audioPool.get(blobUrl) ?? []) {
      if (element.paused) continue;
      element.pause();
      try {
        element.currentTime = 0;
      } catch { /* pas encore décodable */ }
    }
  }
}

function play(cue: Cue) {
  if (GATED.has(cue) && !ENABLED()) return;
  if (ACTION_FEEDBACK.has(cue)) stopActionCues();
  // Opt-in: silence every cue while deafened. Off by default — most users like
  // still hearing who joins even while deafened. Action-feedback cues are exempt
  // (you must hear your own mute/deafen confirmation).
  const s = useSettingsStore.getState();
  if (!ACTION_FEEDBACK.has(cue) && s.muteSoundsWhenDeafened && useAppStore.getState().isDeafened) return;
  const custom = overrideFor(cue);
  if (custom) {
    void playCustom(custom).then((ok) => {
      logCue(`${cue}: personnalisé ${ok ? "joué" : "échec → défaut"}`);
      if (!ok) playDefault(cue); // custom failed → fall back
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
  for (const timer of pendingLeaves.values()) clearTimeout(timer);
  pendingLeaves.clear();
  bouncedBack.clear();
}

/** Préchauffe les cues de retour d'action (micro, sourdine) dès l'entrée en
 *  vocal.
 *
 *  Mesuré le 16/09 : le TOUT PREMIER unmute d'une session mettait environ deux
 *  secondes entre la fin de l'opération moteur (91 ms) et le début du son —
 *  entièrement passées dans le chargement et le décodage du fichier. Les
 *  lectures suivantes, servies par le bassin d'éléments déjà décodés, partent
 *  sans délai. Décoder à l'entrée en vocal supprime aussi ce premier retard,
 *  au moment où l'utilisateur n'attend encore aucun son. */
export async function primeActionCues(): Promise<void> {
  const cues: Cue[] = ["mute", "unmute", "deafen", "undeafen"];
  await Promise.all(
    cues.map(async (cue) => {
      // Un override utilisateur a son propre chemin de lecture ; on ne
      // préchauffe que les fichiers par défaut du bundle.
      if (overrideFor(cue)) return;
      const url = fileFor(cue);
      if (url) await primeCue(url);
      // Décodage PCM du chemin natif, pour que le premier mute en appel
      // n'attende pas non plus.
      if (!NEVER_NATIVE.has(cue)) await nativePcmFor(cue).catch(() => null);
    }),
  );
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

// ── Anti-clignotement des reconnexions ─────────────────────────────────────
// Une reconnexion d'un pair se présente comme : piste dépubliée → « parti »
// (raison UnknownReason) → « rejoint » → piste republiée, le tout dans la même
// seconde (constaté en log le 12/09). Annoncer un départ ET un retour pour ça,
// c'est sonoriser un événement qui n'a pas eu lieu. Le départ est donc RETARDÉ
// de `LEAVE_GRACE_MS` : si le pair revient pendant la fenêtre, les deux cues
// sont annulés — il n'a jamais semblé absent.
const LEAVE_GRACE_MS = 1800;
const pendingLeaves = new Map<string, ReturnType<typeof setTimeout>>();
/** Pairs revenus pendant leur fenêtre de grâce : leur « join » ne sonne pas. */
const bouncedBack = new Set<string>();

/** Un pair vient d'apparaître dans la liste des participants. */
export function onParticipantJoined(identity: string) {
  const pending = pendingLeaves.get(identity);
  if (pending != null) {
    // Clignotement : on annule le départ en attente ET on tait le retour.
    clearTimeout(pending);
    pendingLeaves.delete(identity);
    bouncedBack.add(identity);
    return;
  }
  // Le retour consomme la marque ; les apparitions suivantes sonnent normalement.
  if (bouncedBack.delete(identity)) return;
  playJoinCue();
}

export function onParticipantLeft(identity: string) {
  const now = Date.now();
  const prev = recentLeaves.get(identity);
  if (prev != null && now - prev < LEAVE_DEDUP_MS) {
    // Duplicate ParticipantDisconnected — first call already scheduled the cue.
    lostPeers.delete(identity);
    return;
  }
  if (pendingLeaves.has(identity)) return;
  recentLeaves.set(identity, now);
  const timedOut = lostPeers.delete(identity);
  // A kicked peer's departure is already announced by the kick cue.
  if (wasRecentlyKicked(identity)) return;
  const timer = setTimeout(() => {
    pendingLeaves.delete(identity);
    play(timedOut ? "timeout" : "leave");
  }, LEAVE_GRACE_MS);
  pendingLeaves.set(identity, timer);
}
