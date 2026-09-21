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

/**
 * L'AV1 dans un conteneur MP4 se reconnaît à l'entrée `av01` de sa table
 * d'échantillons. On la cherche dans les premiers kilo-octets, où vit l'entête
 * d'un MP4 préparé pour la diffusion.
 */
function mp4ContientAv1(bytes: Uint8Array): boolean {
  const debut = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  const motif = [0x61, 0x76, 0x30, 0x31]; // "av01"
  for (let i = 0; i + 3 < debut.length; i++) {
    if (debut[i] === motif[0] && debut[i + 1] === motif[1]
      && debut[i + 2] === motif[2] && debut[i + 3] === motif[3]) return true;
  }
  return false;
}

/** Vrai si le fichier peut partir tel quel : un WebM en VP8/VP9 ou AV1, ou un
 *  MP4 déjà en AV1 — les formats que tous les runtimes cibles savent lire. */
function alreadyCompatible(file: File, bytes: Uint8Array): boolean {
  // MP4 contenant déjà de l'AV1 : c'est le format cible, dans un autre
  // conteneur.
  //
  // La garde ne regardait que le WebM. Or l'import par lien rend un MP4 selon
  // le format retenu chez la source : le fichier, déjà normalisé à l'import,
  // était intégralement réencodé une seconde fois à l'envoi (18/09). Deux
  // conversions longues pour un résultat identique.
  if (file.type.includes("mp4") || file.name.toLowerCase().endsWith(".mp4")) {
    return mp4ContientAv1(bytes);
  }
  if (!file.type.includes("webm")) return false;
  const codec = detectWebmVideoCodec(bytes);
  // L'AV1 est déjà le format cible : le réencoder ne ferait que perdre de la
  // qualité pour rien. VP8 et VP9 restent acceptés tels quels — les réencoder
  // en AV1 coûterait du temps pour un gain marginal sur des fichiers déjà
  // compressés.
  return codec === "vp8" || codec === "vp9" || codec === "av1";
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
  const ext = (file.name.split(".").pop() || "bin").toLowerCase();

  /**
   * Réencoder ou non : **seule la taille décide**.
   *
   * Le critère était le codec, pour garantir que le destinataire puisse lire.
   * Ça n'a jamais marché — on réencodait en AV1 et la lecture échouait quand
   * même chez qui n'avait pas le bon greffon — et ça n'a plus lieu d'être :
   * le lecteur décode lui-même, hors du moteur web (voir
   * docs/lecteur-video-natif.md). Reste la seule contrainte réelle : le
   * serveur refuse au-delà de sa limite d'envoi.
   *
   * Un clip qui tient dans la limite part donc tel quel, quel que soit son
   * format — plus d'attente de conversion pour rien.
   */
  const { getMaxUploadSize } = await import("./matrixService");
  const limite = await getMaxUploadSize().catch(() => 0);
  // Marge : le conteneur et les métadonnées s'ajoutent à l'envoi, et un
  // fichier refusé au dernier moment aurait coûté tout le téléversement.
  const tientDansLaLimite = limite > 0 && file.size <= limite * 0.95;
  const compatible = tientDansLaLimite || alreadyCompatible(file, bytes);

  void import("@tauri-apps/plugin-log")
    .then(({ info }) => info(
      `[Sion][vidéo] envoi : ${file.name} (${file.type || "type inconnu"}, `
      + `${(file.size / 1048576).toFixed(1)} Mo) — limite ${(limite / 1048576).toFixed(0)} Mo, `
      + `réencodage ${compatible ? "inutile" : "nécessaire"}`,
    ))
    .catch(() => { /* hors Tauri */ });

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
  // L'extension suit le type réellement produit : AV1/MP4 en temps normal,
  // WebM si ffmpeg a dû se rabattre sur VP9.
  const outExt = prepared.mimetype.includes("webm") ? "webm" : "mp4";
  const name = prepared.transcoded
    ? `${file.name.replace(/\.[^.]+$/, "")}.${outExt}`
    : file.name;
  return {
    file: new File([blob], name, { type: prepared.mimetype }),
    width: prepared.width,
    height: prepared.height,
    durationMs: prepared.durationMs,
    transcoded: prepared.transcoded,
  };
}
