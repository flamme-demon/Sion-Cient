// Voix générées — pont vers le moteur audio.cpp côté Rust.
//
// Le clonage se fait à partir d'un extrait de référence (3-10 s) : il n'y a pas
// de profil intermédiaire à gérer, l'extrait EST la voix. Il est donc stocké
// dans la room soundboard comme n'importe quel son, via `uploadSound`.
//
// Le WAV produit est renvoyé sous forme de File, directement consommable par le
// pipeline soundboard existant.
import { useSettingsStore } from "../stores/useSettingsStore";

export interface TtsModelInfo {
  id: string;
  family: string;
  /** Taille approximative du téléchargement, pour prévenir avant d'installer. */
  sizeMb: number;
  /** Le modèle exige la transcription exacte de l'extrait (Higgs, Qwen3). */
  needsReferenceText: boolean;
  installed: boolean;
}

/** Libellés d'affichage — le backend ne renvoie que des identifiants. */
export const TTS_MODEL_LABELS: Record<string, string> = {
  chatterbox: "Chatterbox",
  higgs_v3: "Higgs Audio v3",
  qwen3_tts: "Qwen3-TTS",
};

type RawModel = {
  id: string;
  family: string;
  size_mb: number;
  needs_reference_text: boolean;
  installed: boolean;
};

export async function listTtsModels(): Promise<TtsModelInfo[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<RawModel[]>("list_tts_models");
  return raw.map((m) => ({
    id: m.id,
    family: m.family,
    sizeMb: m.size_mb,
    needsReferenceText: m.needs_reference_text,
    installed: m.installed,
  }));
}

/** Chemin du moteur s'il est utilisable, sinon null. */
export async function detectTtsEngine(): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (
    (await invoke<string | null>("detect_tts_engine", {
      customPath: useSettingsStore.getState().ttsEnginePath || undefined,
    })) ?? null
  );
}

/** Sélecteur natif — nécessaire sur Linux/macOS où l'amont ne publie pas de binaire. */
export async function pickTtsEnginePath(): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke<string | null>("pick_tts_engine_path")) ?? null;
}

export async function installTtsEngine(onProgress?: (pct: number) => void): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = onProgress
    ? await listen<number>("tts-engine-progress", (e) => onProgress(e.payload))
    : null;
  try {
    return await invoke<string>("download_tts_engine");
  } finally {
    unlisten?.();
  }
}

export async function installTtsModel(
  model: string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = onProgress
    ? await listen<number>("tts-model-progress", (e) => onProgress(e.payload))
    : null;
  try {
    return await invoke<string>("download_tts_model", { model });
  } finally {
    unlisten?.();
  }
}

export async function deleteTtsModel(model: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("delete_tts_model", { model });
}

/**
 * Génère la parole et renvoie le WAV.
 *
 * `voiceRefPath` est un chemin sur disque : le moteur lit le fichier lui-même,
 * on ne fait pas transiter les octets par l'IPC (un extrait fait plusieurs
 * centaines de Ko, et le WAV produit revient déjà par ce canal).
 */
export async function generateSpeech(
  model: string,
  text: string,
  voiceRefPath: string,
  referenceText?: string,
): Promise<File> {
  const { invoke } = await import("@tauri-apps/api/core");
  const wavPath = await invoke<string>("tts_generate", {
    model,
    text,
    voiceRef: voiceRefPath,
    referenceText: referenceText || undefined,
    language: "fr",
    enginePath: useSettingsStore.getState().ttsEnginePath || undefined,
  });
  const b64 = await invoke<string>("read_file_b64", { path: wavPath });
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], "voix.wav", { type: "audio/wav" });
}

/**
 * Catégorie donnée aux extraits de référence.
 *
 * Purement organisationnelle : c'est le drapeau `kind: "voice"` qui les
 * distingue des sons jouables, parce qu'une catégorie reste librement
 * renommable par l'utilisateur.
 *
 * Une voix EST un son de la room soundboard — `uploadSound` / `listSounds` la
 * gèrent déjà, et le partage entre membres est acquis. Aucun namespace Matrix
 * nouveau.
 */
export const VOICE_CATEGORY = "Voix";

/**
 * Catégorie des sons PRODUITS par la génération.
 *
 * Distincte de `VOICE_CATEGORY` : ranger les résultats avec les références
 * polluait le sélecteur d'extrait, qui se remplissait des voix générées au fil
 * des essais.
 */
export const GENERATED_CATEGORY = "Voix générées";

/**
 * Encode une portion d'AudioBuffer en WAV PCM 16 bits mono.
 *
 * `--voice-ref` n'accepte QUE du WAV : lui passer le mp3/ogg d'origine échoue
 * sur « invalid WAV RIFF header ». Et `trimToClip` (soundboard) produit du
 * webm/opus via MediaRecorder, donc inutilisable ici.
 *
 * Mono parce que les encodeurs de locuteur ne lisent que le premier canal :
 * autant faire la moyenne nous-mêmes plutôt que de jeter la moitié du signal.
 */
export function bufferToWav(buffer: AudioBuffer, startSec = 0, endSec?: number): File {
  const rate = buffer.sampleRate;
  const from = Math.max(0, Math.floor(startSec * rate));
  const to = Math.min(buffer.length, Math.floor((endSec ?? buffer.duration) * rate));
  const n = Math.max(1, to - from);

  const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const bytes = new ArrayBuffer(44 + n * 2);
  const view = new DataView(bytes);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // taille du bloc fmt
  view.setUint16(20, 1, true); // PCM entier
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // octets par seconde
  view.setUint16(32, 2, true); // alignement de bloc
  view.setUint16(34, 16, true); // bits par échantillon
  ascii(36, "data");
  view.setUint32(40, n * 2, true);

  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const ch of chans) s += ch[from + i] || 0;
    s /= chans.length;
    // Écrêtage avant conversion : un buffer peut dépasser [-1, 1] après un
    // gain, et le repli entier produirait un craquement.
    s = Math.max(-1, Math.min(1, s));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new File([bytes], "ref.wav", { type: "audio/wav" });
}

/**
 * Taux d'échantillonnage des extraits de référence.
 *
 * Les modèles travaillent en 24 kHz (Chatterbox s3gen, Higgs) et n'exploitent
 * rien au-delà — garder les 48 kHz du décodage double le poids sans rien
 * apporter. À 48 Ko/s, un extrait de 10 s tient largement sous le plafond de
 * 1 Mo de la soundboard, que le WAV brut dépassait dès 11 secondes.
 */
export const REF_SAMPLE_RATE = 24000;

/**
 * Rééchantillonne puis encode l'extrait en WAV prêt pour le moteur.
 *
 * Le rééchantillonnage passe par un OfflineAudioContext : c'est le seul moyen
 * correct côté navigateur, une décimation naïve replierait les aigus.
 */
export async function encodeRefWav(
  buffer: AudioBuffer,
  startSec = 0,
  endSec?: number,
): Promise<File> {
  const from = Math.max(0, startSec);
  const to = Math.min(buffer.duration, endSec ?? buffer.duration);
  const frames = Math.max(1, Math.round((to - from) * REF_SAMPLE_RATE));
  if (buffer.sampleRate === REF_SAMPLE_RATE) return bufferToWav(buffer, from, to);

  const ctx = new OfflineAudioContext(1, frames, REF_SAMPLE_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0, from, to - from);
  return bufferToWav(await ctx.startRendering());
}

/**
 * Écrit un File sur disque et renvoie son chemin — le moteur lit `--voice-ref`
 * depuis le système de fichiers, pas depuis l'IPC.
 *
 * Sert aussi bien pour un fichier choisi localement que pour un extrait
 * récupéré depuis Matrix : les deux arrivent ici sous forme de File.
 */
export async function materializeRef(file: File): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  // Par tranches : String.fromCharCode(...buf) dépasse la taille max de pile
  // sur un extrait de quelques centaines de Ko.
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  const ext = (file.name.split(".").pop() || "wav").toLowerCase();
  return await invoke<string>("save_imported_audio", { dataB64: btoa(bin), ext });
}

/**
 * Transcrit l'extrait de référence avec le moteur ASR déjà embarqué
 * (`transcribe-cpp`, Parakeet/Whisper GGUF), pour pré-remplir `--reference-text`.
 *
 * Higgs et Qwen3 exigent une transcription EXACTE : un texte approximatif fait
 * dériver la génération sans le signaler. Faire relire une proposition à
 * l'utilisateur vaut mieux que lui faire tout saisir.
 *
 * Réutilise le serveur WebSocket du moteur de réunion : on lui pousse le
 * fichier décodé en PCM 16 kHz au lieu du micro, puis on recolle les segments.
 *
 * Refuse de tourner pendant une transcription de réunion : `transcribe_start`
 * recharge le modèle et couperait la session en cours.
 */
export async function transcribeRef(file: File): Promise<string> {
  const { isTranscribing, ensureModelDownloaded } = await import("./transcriptionService");
  if (isTranscribing()) throw new Error("busy");

  const { invoke } = await import("@tauri-apps/api/core");
  const { transcribeModel, transcribeLang } = useSettingsStore.getState();
  const modelPath = await ensureModelDownloaded(transcribeModel);
  const port = await invoke<number>("transcribe_start", { modelPath, lang: transcribeLang });

  // Le moteur attend du 16 kHz mono : on laisse decodeAudioData rééchantillonner.
  const ctx = new AudioContext({ sampleRate: 16000 });
  let pcm: Float32Array;
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    pcm = buf.getChannelData(0).slice();
  } finally {
    await ctx.close().catch(() => {});
  }

  return await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.binaryType = "arraybuffer";
    const parts: string[] = [];
    // Le moteur n'annonce pas la fin d'un flux : on clôt un court instant après
    // le dernier segment reçu, ou au plus tard au bout de 60 s.
    let idle: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (idle) clearTimeout(idle);
      clearTimeout(hard);
      try { ws.close(); } catch { /* déjà fermé */ }
      void invoke("transcribe_stop").catch(() => {});
      resolve(parts.join(" ").replace(/\s+/g, " ").trim());
    };
    const hard = setTimeout(finish, 60_000);

    ws.onopen = () => {
      // Tranches de ~1 s : le VAD travaille sur des trames courtes et le
      // moteur borne sa file d'attente de segments.
      const CHUNK = 16000;
      for (let i = 0; i < pcm.length; i += CHUNK) {
        ws.send(pcm.slice(i, i + CHUNK).buffer);
      }
      ws.send(JSON.stringify({ type: "flush" }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as { type: string; text?: string; message?: string };
        if (msg.type === "segment" && msg.text) {
          parts.push(msg.text);
          if (idle) clearTimeout(idle);
          idle = setTimeout(finish, 2500);
        } else if (msg.type === "error") {
          clearTimeout(hard);
          try { ws.close(); } catch { /* déjà fermé */ }
          void invoke("transcribe_stop").catch(() => {});
          reject(new Error(msg.message || "engine error"));
        } else if (msg.type === "ready" && !idle) {
          // Rien reçu passé ce délai = extrait sans parole détectable.
          idle = setTimeout(finish, 15_000);
        }
      } catch { /* trame malformée */ }
    };
    ws.onerror = () => {
      clearTimeout(hard);
      void invoke("transcribe_stop").catch(() => {});
      reject(new Error("websocket"));
    };
  });
}

/** Durée conseillée pour un extrait de référence (secondes). */
export const REF_MIN_SEC = 3;
export const REF_MAX_SEC = 10;

/**
 * Un extrait trop court ne porte pas assez de timbre, trop long il sort de la
 * fenêtre exploitée par les encodeurs. Renvoie un message d'avertissement ou
 * null si la durée convient.
 *
 * Volontairement non bloquant : audio.cpp accepte des extraits hors de cette
 * plage (y compris des montages de fragments, testé), c'est juste moins bon.
 */
export function checkRefDuration(seconds: number): string | null {
  if (seconds < REF_MIN_SEC) return "tooShort";
  if (seconds > REF_MAX_SEC) return "tooLong";
  return null;
}

/**
 * Résout un mxc de portrait en URL affichable.
 *
 * Les médias Matrix v1.11+ passent par un point d'accès authentifié : un
 * `<img src="mxc://…">` ou même l'URL http nue renverrait 401. On télécharge
 * donc avec le jeton et on expose un blob.
 */
export async function resolveAvatar(mxcUrl: string): Promise<string | null> {
  const { getMatrixClient } = await import("./matrixService");
  const client = getMatrixClient();
  if (!client) return null;
  const httpUrl = client.mxcUrlToHttp(mxcUrl, 96, 96, "crop", true, true, true);
  if (!httpUrl) return null;
  try {
    const token = client.getAccessToken();
    const res = await fetch(httpUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}
