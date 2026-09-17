import { detectWebmVideoCodec } from "../utils/webmCodec";
import { useSettingsStore } from "../stores/useSettingsStore";

/** Levée quand ffmpeg manque : l'appelant propose alors de l'installer plutôt
 *  que d'afficher une erreur technique. */
export class FfmpegMissingError extends Error {
  constructor() {
    super("ffmpeg est requis pour envoyer une vidéo");
    this.name = "FfmpegMissingError";
  }
}

export interface PreparedVideo {
  file: File;
  width: number;
  height: number;
  durationMs: number;
  /** Faux quand la source était déjà au bon format et n'a pas été ré-encodée. */
  transcoded: boolean;
}

interface RustPreparedVideo {
  path: string;
  mimetype: string;
  width: number;
  height: number;
  durationMs: number;
  transcoded: boolean;
}

function isTauriDesktop(): boolean {
  return typeof window !== "undefined"
    && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** Vrai si le fichier peut partir tel quel : WebM dont la piste vidéo est en
 *  VP8 ou VP9, les deux codecs que tous les runtimes cibles savent lire. */
function alreadyCompatible(file: File, bytes: Uint8Array): boolean {
  if (!file.type.includes("webm")) return false;
  const codec = detectWebmVideoCodec(bytes);
  return codec === "vp8" || codec === "vp9";
}

/**
 * Normalise une vidéo avant l'envoi : WebM VP9 + Opus, avec ses dimensions et
 * sa durée.
 *
 * Pourquoi côté expéditeur. Le fichier partait tel quel et chaque destinataire
 * le convertissait chez lui : cinq destinataires, cinq encodages `libvpx-vp9`
 * de plusieurs minutes, et rien du tout pour qui n'avait pas ffmpeg. L'import
 * par URL normalisait déjà (`recodeWebm`) ; le glisser-déposer, non. Le coût est
 * désormais payé une fois, par celui qui envoie.
 *
 * Les dimensions et la durée voyagent avec l'événement Matrix : le destinataire
 * peut réserver la place de la vidéo avant de l'avoir téléchargée, au lieu de
 * voir la mise en page sauter.
 *
 * Hors bureau (mobile, web) la fonction rend le fichier inchangé : ffmpeg n'y
 * est pas disponible, et bloquer l'envoi y serait une régression.
 */
/**
 * Lit un fichier du dossier média et rend ses octets.
 *
 * `invoke` ne garantit pas la forme du retour d'une réponse binaire : selon que
 * l'IPC passe par le protocole personnalisé ou retombe sur `postMessage`, on
 * reçoit un `ArrayBuffer` ou un tableau de nombres. Passer ce dernier tel quel
 * à `new Blob([...])` le sérialise en texte et produit un blob illisible —
 * indiscernable d'un fichier corrompu. On normalise donc, et on journalise la
 * taille et la signature pour que le prochain échec soit lisible du premier
 * coup.
 */
export async function readMediaBytes(path: string, label: string): Promise<Uint8Array<ArrayBuffer>> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<ArrayBuffer | number[]>("read_media", { path });
  const bytes: Uint8Array<ArrayBuffer> = raw instanceof ArrayBuffer
    ? new Uint8Array(raw)
    : Uint8Array.from(raw as number[]);
  const magic = [...bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  void import("@tauri-apps/plugin-log")
    .then(({ info }) => info(
      `[Sion][vidéo] ${label} : ${bytes.byteLength} o, forme=${Object.prototype.toString.call(raw)}, signature=${magic}`,
    ))
    .catch(() => { /* hors Tauri */ });
  return bytes;
}

export async function prepareVideoForSend(file: File): Promise<PreparedVideo> {
  if (!isTauriDesktop()) {
    return { file, width: 0, height: 0, durationMs: 0, transcoded: false };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const compatible = alreadyCompatible(file, bytes);
  const ext = (file.name.split(".").pop() || "bin").toLowerCase();

  // Les octets traversent l'IPC en binaire brut, jamais en base64.
  const stagedPath = await invoke<string>("stage_media", bytes, {
    headers: { "x-sion-ext": ext },
  });

  const ffmpegPath = useSettingsStore.getState().ffmpegPath;
  let prepared: RustPreparedVideo;
  try {
    prepared = await invoke<RustPreparedVideo>("prepare_video_for_send", {
      inputPath: stagedPath,
      ffmpegPath,
      alreadyCompatible: compatible,
    });
  } catch (err) {
    // Distinguer « ffmpeg absent » d'un vrai échec d'encodage : seul le premier
    // se répare d'un clic.
    const found = await invoke<string | null>("detect_ffmpeg").catch(() => null);
    if (!found) throw new FfmpegMissingError();
    throw err;
  }

  // Retour en binaire brut, jamais en base64 : le protocole `asset` a été
  // essayé et ne tient pas sous WebKitGTK.
  const outBytes = await readMediaBytes(prepared.path, "préparé pour l'envoi");
  const blob = new Blob([outBytes], { type: prepared.mimetype });
  const name = prepared.transcoded
    ? `${file.name.replace(/\.[^.]+$/, "")}.webm`
    : file.name;
  return {
    file: new File([blob], name, { type: prepared.mimetype }),
    width: prepared.width,
    height: prepared.height,
    durationMs: prepared.durationMs,
    transcoded: prepared.transcoded,
  };
}
