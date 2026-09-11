/**
 * Meeting transcription — desktop/Tauri.
 *
 * Le micro est tapé côté Rust (`sion-native-audio::transcription_tap`, après
 * AEC/NS/AGC), rééchantillonné en 16 kHz mono et segmenté par
 * `transcribe.rs` (VAD + Whisper/Parakeet). Le front ne transporte plus de
 * PCM : il ouvre le WebSocket local pour recevoir `ready`/`segment` et
 * publie chaque segment dans le salon Matrix (`com.sion.transcript`).
 * L'intention « armé » voyage sur un data packet natif
 * (`sion-transcribe-arm`), comme le faisait le data channel LiveKit.
 *
 * Contrat mute : le moteur Rust coupe le tap dès que le micro est muet
 * (mute ou sourdine) et ferme le segment en cours — aucun audio muet
 * n'atteint le modèle.
 */

import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/useAppStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranscriptStore } from "../stores/useTranscriptStore";
import * as matrixService from "./matrixService";

function isTauri(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (globalThis as any).__TAURI_INTERNALS__ !== "undefined";
}

/** Topic natif de l'intention « je participe à la transcription ». */
export const TRANSCRIBE_ARM_TOPIC = "sion-transcribe-arm";

interface Session {
  roomId: string;
  ws: WebSocket | null;
  unsubApp: (() => void) | null;
}

let session: Session | null = null;

/** True while WE are transcribing (someone else may be regardless). */
export function isTranscribing(): boolean {
  return session !== null;
}

// ---------------------------------------------------------------------------
// Intention « armé » — data packet natif (remplace le data channel LiveKit).
// ---------------------------------------------------------------------------

const armedTranscribers = new Set<string>();
let localArmed = false;
let armedCallback: ((identities: string[]) => void) | null = null;

function setLocalArmed(armed: boolean) {
  localArmed = armed;
  if (!isTauri()) return;
  void (async () => {
    const { voiceNativePublishData, bytesToB64 } = await import("./voiceNativeService");
    const payload = new TextEncoder().encode(JSON.stringify({ armed }));
    await voiceNativePublishData(TRANSCRIBE_ARM_TOPIC, bytesToB64(payload), true);
  })().catch(() => { /* hors session vocale */ });
}

/** Paquet `sion-transcribe-arm` d'un pair (relayé par `useLiveKit`). */
export function handleArmData(sender: string, payload: Uint8Array): void {
  if (!sender) return;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as { armed?: boolean };
    const before = armedTranscribers.size;
    if (parsed.armed === true) armedTranscribers.add(sender);
    else armedTranscribers.delete(sender);
    if (armedTranscribers.size !== before) {
      console.log(
        `[Sion][transcribe] ${sender} ${parsed.armed ? "armé" : "désarmé"} (${armedTranscribers.size} pair(s) armé(s))`,
      );
      armedCallback?.(Array.from(armedTranscribers));
    }
  } catch { /* paquet étranger */ }
}

/** Re-diffuse notre intention (un pair vient de rejoindre le vocal). */
export function rebroadcastTranscribeArm(): void {
  if (localArmed) setLocalArmed(true);
}

/** Retire les pairs partis (appelé à chaque mise à jour des participants). */
export function syncArmedTranscribers(identities: string[]): void {
  const present = new Set(identities);
  let changed = false;
  for (const id of Array.from(armedTranscribers)) {
    if (!present.has(id)) {
      armedTranscribers.delete(id);
      changed = true;
    }
  }
  if (changed) {
    console.log(`[Sion][transcribe] pairs armés après départ: ${armedTranscribers.size}`);
    armedCallback?.(Array.from(armedTranscribers));
  }
}

// ---------------------------------------------------------------------------
// Moteur local (tap Rust → WS de sortie).
// ---------------------------------------------------------------------------

/** Démarre NOTRE moteur. Le store passe à "on" quand le modèle signale
 *  `ready` sur le WebSocket (chargement ~1 s pour Parakeet). */
async function startEngine(roomId: string): Promise<void> {
  if (!isTauri()) throw new Error("desktop only");
  if (session) await stopEngine();

  const store = useTranscriptStore.getState();
  store.setState("starting");
  const { transcribeModel, transcribeLang } = useSettingsStore.getState();
  const modelPath = await ensureModelDownloaded(transcribeModel);

  const { isMuted, isDeafened } = useAppStore.getState();
  const port = await invoke<number>("transcribe_start_native", {
    modelPath,
    lang: transcribeLang,
    micEnabled: !isMuted && !isDeafened,
  });

  const s: Session = { roomId, ws: null, unsubApp: null };
  session = s;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  s.ws = ws;
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data) as {
        type: string;
        text?: string;
        t0?: number;
        t1?: number;
        message?: string;
      };
      if (msg.type === "ready") {
        useTranscriptStore.getState().setState("on");
      } else if (msg.type === "error") {
        console.error("[Sion][transcribe] erreur moteur:", msg.message);
        useTranscriptStore.getState().setState("error", msg.message || "engine error");
      } else if (msg.type === "segment" && msg.text) {
        const t0 = msg.t0 ?? Date.now();
        const t1 = msg.t1 ?? t0;
        // Publié dans le salon : notre propre entrée revient par le même
        // chemin Matrix que celle des autres (echo dédupliqué).
        const sessionId = useTranscriptStore.getState().sessions[s.roomId]?.id;
        matrixService.sendTranscriptSegment(s.roomId, msg.text, t0, t1, sessionId).catch((err) => {
          console.warn("[Sion][transcribe] publication du segment échouée:", err);
        });
      }
    } catch { /* malformed */ }
  };
  ws.onclose = () => {
    if (session === s && useTranscriptStore.getState().state !== "error") {
      useTranscriptStore.getState().setState("off");
    }
  };

  // Un transcript ne doit pas survivre à la réunion qu'il décrit.
  s.unsubApp = useAppStore.subscribe((state) => {
    if (state.connectedVoiceChannel !== s.roomId) {
      console.log("[Sion][transcribe] sortie du vocal → arrêt");
      disarmTranscription(s.roomId);
    }
  });
}

/** Arrête NOTRE moteur : le tap et le modèle sont libérés côté Rust. Les
 *  transcripts distants continuent d'arriver par Matrix. */
async function stopEngine(): Promise<void> {
  const s = session;
  session = null;
  if (!s) return;
  s.unsubApp?.();
  try { s.ws?.close(); } catch { /* déjà fermé */ }
  try { await invoke("transcribe_stop"); } catch { /* pas lancé */ }
  if (useTranscriptStore.getState().state !== "error") {
    useTranscriptStore.getState().setState("off");
  }
}

// ---------------------------------------------------------------------------
// Sessions — modèle de consentement :
//  - s'armer seul ne transcrit RIEN ; la session démarre quand un SECOND
//    participant s'arme (intention sur le data packet natif) ;
//  - le démarrage forge un uuid + date, publié en événement Matrix durable
//    (`com.sion.transcript.session`) — ancre de l'historique ;
//  - n'importe qui peut terminer la session pour tout le monde.
// ---------------------------------------------------------------------------

/** Ignore les démarrages plus vieux que ça lors du rejeu d'historique : une
 *  session dont le client a crashé sans `end` ne doit pas ressusciter. */
const SESSION_FRESHNESS_MS = 12 * 3600 * 1000;

let armedRoom: string | null = null;
/** Une seule proposition de session par armement — la course avec l'autre
 *  côté se résout par adoption du plus ancien, pas par renvoi. */
let sessionProposed = false;
let unsubArmWatch: (() => void) | null = null;

function clearArmWatch() {
  armedCallback = null;
  unsubArmWatch?.();
  unsubArmWatch = null;
}

/** S'armer : déclare l'intention et démarre dès qu'un second participant est
 *  armé. Si une session tourne déjà, on la rejoint immédiatement. */
export async function armTranscription(roomId: string): Promise<void> {
  if (!isTauri()) throw new Error("desktop only");
  const store = useTranscriptStore.getState();
  if (session || armedRoom) return; // moteur déjà lancé ou déjà armé

  const active = store.sessions[roomId];
  setLocalArmed(true);
  if (active && !active.endedAt) {
    // Session déjà live — la barrière des ≥2 est franchie ; on rejoint.
    await startEngine(roomId);
    return;
  }

  armedRoom = roomId;
  sessionProposed = false;
  store.setState("armed");

  const maybePropose = () => {
    if (sessionProposed || armedRoom !== roomId) return;
    if (armedTranscribers.size >= 1) {
      sessionProposed = true;
      // Course possible avec l'autre côté : les deux événements arrivent,
      // tout le monde adopte le plus ancien (cf. `handleSessionEvent`).
      matrixService
        .sendTranscriptSession(roomId, "start", crypto.randomUUID(), Date.now())
        .catch((err) => {
          console.warn("[Sion][transcribe] publication du début de session échouée:", err);
          sessionProposed = false;
        });
    }
  };

  armedCallback = () => maybePropose();
  maybePropose(); // un pair était déjà armé avant nous

  // Se désarmer si on quitte le vocal en attendant un pair.
  unsubArmWatch = useAppStore.subscribe((state) => {
    if (state.connectedVoiceChannel !== roomId) disarmTranscription(roomId);
  });
}

/** Stop OUR participation (engine + armed intent). The session keeps
 *  running for the others — ending it for everyone is `endSessionForAll`. */
export function disarmTranscription(roomId: string): void {
  void roomId;
  clearArmWatch();
  armedRoom = null;
  sessionProposed = false;
  setLocalArmed(false);
  if (session) {
    void stopEngine();
  } else if (useTranscriptStore.getState().state === "armed") {
    useTranscriptStore.getState().setState("off");
  }
}

/** End the CURRENT session for every participant (any member may do this). */
export async function endSessionForAll(roomId: string): Promise<void> {
  const cur = useTranscriptStore.getState().sessions[roomId];
  if (!cur || cur.endedAt) return;
  await matrixService.sendTranscriptSession(roomId, "end", cur.id, Date.now());
  // Apply locally right away — the event echo is deduped by endedAt.
  handleSessionEvent(roomId, "end", cur.id, Date.now(), "");
}

/** React to a `com.sion.transcript.session` event (live, echo or history
 *  replay). Called from the useMatrixStore timeline/decrypted routers. */
export function handleSessionEvent(roomId: string, action: "start" | "end", id: string, ts: number, sender: string): void {
  const store = useTranscriptStore.getState();
  const cur = store.sessions[roomId];

  // Every sighting feeds the history, including starts too stale to adopt
  // as the live session below.
  store.upsertHistorySession(
    roomId,
    action === "start" ? { id, ts, startedBy: sender } : { id, endedAt: ts },
  );

  if (action === "start") {
    if (Date.now() - ts > SESSION_FRESHNESS_MS) return; // stale history
    if (cur && !cur.endedAt) {
      // Concurrent proposals: adopt the earliest (ties: lowest uuid) so all
      // clients converge on the same session id.
      if (cur.id === id) return;
      if (ts > cur.ts || (ts === cur.ts && id > cur.id)) return;
    }
    store.setSession(roomId, { id, ts, startedBy: sender });
    console.log(`[Sion][transcribe] session ${id.slice(0, 8)} adopted (started by ${sender || "?"})`);
    // On attendait le second participant — la session existe, on démarre.
    if (armedRoom === roomId && !session) {
      clearArmWatch();
      armedRoom = null;
      startEngine(roomId).catch((err) => {
        console.error("[Sion][transcribe] démarrage moteur échoué:", err);
        useTranscriptStore.getState().setState("error", String((err as Error)?.message || err));
      });
    }
    return;
  }

  // action === "end"
  if (!cur || cur.id !== id || cur.endedAt) return;
  store.setSession(roomId, { ...cur, endedAt: ts });
  console.log(`[Sion][transcribe] session ${id.slice(0, 8)} ended for everyone`);
  clearArmWatch();
  armedRoom = null;
  sessionProposed = false;
  setLocalArmed(false);
  if (session) {
    void stopEngine();
  } else if (useTranscriptStore.getState().state === "armed") {
    useTranscriptStore.getState().setState("off");
  }
}

/** Path of the requested whisper model, downloading it on first use
 *  (~60–540 MB). Progress is surfaced through the transcript store so the
 *  panel and the settings section both render it. */
export async function ensureModelDownloaded(model: string): Promise<string> {
  const existing = await invoke<string | null>("detect_asr_model", { model });
  if (existing) return existing;
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<number>("asr-model-progress", (e) => {
    useTranscriptStore.getState().setDownloadPct(Number(e.payload));
  });
  try {
    return await invoke<string>("download_asr_model", { model });
  } finally {
    unlisten();
    useTranscriptStore.getState().setDownloadPct(null);
  }
}

/** Whether the given model is already on disk (settings indicator). */
export async function isModelDownloaded(model: string): Promise<boolean> {
  if (!isTauri()) return false;
  return !!(await invoke<string | null>("detect_asr_model", { model }));
}

/** Remove a downloaded ASR model from disk (settings 🗑️). */
export async function deleteAsrModel(model: string): Promise<void> {
  await invoke("delete_asr_model", { model });
}

/** Remove the summary assets (llama build + LLM, ~2.7 GB) from disk. Also
 *  the way to upgrade: the next download picks the newest llama build
 *  (Vulkan-first since it exists). */
export async function deleteSummaryAssets(): Promise<void> {
  await invoke("delete_summary_assets");
}

// ---------------------------------------------------------------------------
// Phase 2 — meeting summary (local llama.cpp over the transcript).
// ---------------------------------------------------------------------------

interface SummaryAssets { llama: string | null; model: string | null }

/** Whether both summary assets (llama-cli + LLM model) are on disk. */
export async function summaryAssetsStatus(): Promise<{ llama: boolean; model: boolean }> {
  if (!isTauri()) return { llama: false, model: false };
  const a = await invoke<SummaryAssets>("detect_summary_assets");
  return { llama: !!a.llama, model: !!a.model };
}

/** Download whatever summary asset is missing (llama binary ~18 MB, LLM
 *  model ~2.5 GB), surfacing progress through the transcript store. */
export async function ensureSummaryAssets(): Promise<void> {
  const store = useTranscriptStore.getState();
  const assets = await invoke<SummaryAssets>("detect_summary_assets");
  const { listen } = await import("@tauri-apps/api/event");
  if (!assets.llama) {
    store.setSummaryState("downloading", 0);
    const un = await listen<number>("llama-install-progress", (e) => {
      useTranscriptStore.getState().setSummaryState("downloading", Number(e.payload));
    });
    try {
      await invoke("download_llama");
    } finally { un(); }
  }
  if (!assets.model) {
    store.setSummaryState("downloading", 0);
    const un = await listen<number>("summary-model-progress", (e) => {
      useTranscriptStore.getState().setSummaryState("downloading", Number(e.payload));
    });
    try {
      await invoke("download_summary_model");
    } finally { un(); }
  }
}

/** Cap fed into the LLM: ~24k chars ≈ 8k tokens of transcript, leaving room
 *  in the 16k context for the template + the generated minutes. A longer
 *  meeting keeps its most recent part (the part a summary reader cares
 *  about most) — chunked map-reduce summarising can come later if needed. */
const MAX_TRANSCRIPT_CHARS = 24_000;

/** Generate meeting minutes from the room's transcript and post them into
 *  the room's chat. Downloads the summary assets on first use. */
export async function summarizeMeeting(roomId: string, sessionId?: string): Promise<void> {
  if (!isTauri()) throw new Error("desktop only");
  const store = useTranscriptStore.getState();
  let entries = useTranscriptStore.getState().entries[roomId] || [];
  // Scoped to one (past) session when the history view asks for it.
  if (sessionId) entries = entries.filter((e) => e.sessionId === sessionId);
  if (!entries.length || store.summaryState !== "idle") return;

  try {
    await ensureSummaryAssets();
    useTranscriptStore.getState().setSummaryState("running");

    const fmt = (ms: number) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    let transcript = entries.map((e) => `[${fmt(e.t0)}] ${e.senderName}: ${e.text}`).join("\n");
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
    }

    const { useSettingsStore } = await import("../stores/useSettingsStore");
    const lang = useSettingsStore.getState().language || "fr";
    const md = await invoke<string>("summarize_transcript", { transcript, lang });

    const title = lang.startsWith("en") ? "## 📝 Meeting summary" : "## 📝 Résumé de la réunion";
    // Tag the message with the session it covers (explicit for a history
    // re-summarize, otherwise the room's current session) so the history
    // view can link back to it.
    const taggedSession = sessionId ?? useTranscriptStore.getState().sessions[roomId]?.id;
    await matrixService.sendSummaryMessage(roomId, `${title}\n\n${md}`, taggedSession);
  } finally {
    useTranscriptStore.getState().setSummaryState("idle");
  }
}
