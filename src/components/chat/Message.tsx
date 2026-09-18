import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CrownIcon, ShieldIcon, FileIcon, DownloadIcon, ReplyIcon, PencilIcon, PinIcon, TrashIcon, EmojiIcon, MessageBubbleIcon } from "../icons";
import { UserAvatar } from "../sidebar/UserAvatar";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { PollMessage } from "./PollMessage";
import { LinkPreview as LinkPreviewInner } from "./LinkPreview";
import { useSettingsStore } from "../../stores/useSettingsStore";

// Lazy-load link previews: only fetch/render when visible in viewport
function LinkPreview({ url }: { url: string }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref}>{visible && <LinkPreviewInner url={url} />}</div>;
}
import type { ChatMessage, UserRole, FileAttachment } from "../../types/matrix";
import { createDecryptedObjectUrl } from "../../utils/decryptMedia";
import { openFileWithDefaultApp, downloadFileToDownloads } from "../../utils/openExternal";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useAppStore } from "../../stores/useAppStore";
import * as matrixService from "../../services/matrixService";
import { EmojiGridPanel } from "./EmojiGridPanel";
import { detectWebmVideoCodec, type WebmVideoCodec as DetectedWebmVideoCodec } from "../../utils/webmCodec";

function roleIcon(role: UserRole) {
  if (role === "admin") return <CrownIcon />;
  if (role === "mod") return <ShieldIcon />;
  return null;
}

function roleColor(role: UserRole): string {
  if (role === "admin") return "var(--color-orange)";
  if (role === "mod") return "var(--color-yellow)";
  return "var(--color-on-surface)";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Résout l'URL affichable d'un attachment — décrypte si E2EE, charge en blob pour vidéo/audio.
 *  `enabled` gates the (heavy) fetch/decrypt so off-screen media isn't downloaded
 *  or transcoded until it's actually scrolled into view. */
function useResolvedUrl(attachment: FileAttachment, enabled: boolean = true): string | null {
  const needsBlob = attachment.mimeType.startsWith("video/") || attachment.mimeType.startsWith("audio/");
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(
    (attachment.encryptedFile || needsBlob) ? null : (attachment.url || null),
  );

  useEffect(() => {
    if (!attachment.url) return;
    if (!enabled) return;

    // E2EE: decrypt to blob
    if (attachment.encryptedFile) {
      let objectUrl: string | null = null;
      createDecryptedObjectUrl(attachment.url, attachment.encryptedFile, attachment.mimeType)
        .then((url) => { objectUrl = url; setResolvedUrl(url); })
        .catch((err) => console.error("[Sion] Décryption media échouée:", err));
      return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }

    // Video/audio: on mobile use direct URL to avoid memory issues,
    // on desktop fetch as blob to avoid Range request issues
    if (needsBlob) {
      const isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (isMobileUA) {
        setResolvedUrl(attachment.url || null);
        return;
      }
      let objectUrl: string | null = null;
      let cancelled = false;
      fetch(attachment.url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((blob) => {
          if (cancelled) return;
          const typed = blob.type ? blob : new Blob([blob], { type: attachment.mimeType });
          objectUrl = URL.createObjectURL(typed);
          setResolvedUrl(objectUrl);
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("[Sion] Chargement media échoué:", err);
          // Fallback to direct URL
          setResolvedUrl(attachment.url || null);
        });
      return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }

    // Images and other files: use direct URL
    setResolvedUrl(attachment.url || null);
  }, [attachment.url, attachment.encryptedFile, attachment.mimeType, needsBlob, enabled]);

  return resolvedUrl;
}

type WebmVideoCodec = DetectedWebmVideoCodec | "pending" | "not-needed";

/** Read the Matroska CodecID without involving the browser media stack. */
async function sniffWebmVideoCodec(url: string): Promise<DetectedWebmVideoCodec> {
  try {
    // Track metadata is near the start. A bounded range avoids copying a whole
    // video just to decide whether it is safe to give to GStreamer.
    const response = await fetch(url, { headers: { Range: "bytes=0-524287" } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return detectWebmVideoCodec(bytes);
  } catch (err) {
    console.warn("[Sion] Détection du codec WebM échouée:", err);
  }
  return "unknown";
}

/** Couleurs du lecteur : posées sur les pixels d'une vidéo, jamais sur une
 *  surface de l'application — donc volontairement hors thème. */
const MEDIA_MATTE = "#000"; // theme-exempt — cadre d'un lecteur vidéo
const MEDIA_INK = "#fff"; // theme-exempt — contrôles posés sur le média

function VideoPlayer({ resolvedUrl, attachment }: { resolvedUrl: string; attachment: FileAttachment }) {
  const { t } = useTranslation();
  // WebKitGTK/GStreamer may start parsing a media source as soon as `src` is
  // attached, even with preload="none".  Some valid-enough WebM files make
  // gst-plugins-good hit a process-wide assertion instead of reporting a
  // media error, so `onError` cannot protect the web process. On Linux/Tauri,
  // inspect the WebM CodecID without the media stack and route AV1/unknown
  // inputs through the existing VP9/Opus compatibility transcode first.
  const isTauriDesktop = typeof window !== "undefined"
    && !!window.__TAURI_INTERNALS__
    && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  // Le transcodage préventif n'existe QUE pour contourner GStreamer sous
  // WebKitGTK. Ailleurs il coûte sans rien apporter : WebView2 est un Chromium
  // complet et lit nativement H.264/AAC, donc un MP4 parfaitement lisible se
  // retrouvait bloqué derrière une conversion — et derrière une installation
  // d'ffmpeg quand elle manquait. Sous Windows et macOS on tente la lecture
  // native et `onError` déclenche la conversion en secours.
  const isLinuxDesktop = isTauriDesktop && /Linux/i.test(navigator.userAgent);
  const isLinuxWebm = isLinuxDesktop && attachment.mimeType.includes("webm");
  const [webmProbe, setWebmProbe] = useState<{ url: string; codec: DetectedWebmVideoCodec } | null>(null);
  const webmCodec: WebmVideoCodec = !isLinuxWebm
    ? "not-needed"
    : webmProbe?.url === resolvedUrl ? webmProbe.codec : "pending";
  const [transcodedUrl, setTranscodedUrl] = useState<string | null>(null);
  const [transcoding, setTranscoding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // true when the transcode failed because ffmpeg isn't installed → offer to
  // install it right from the card. number = install progress %.
  const [ffmpegMissing, setFfmpegMissing] = useState(false);
  const [installing, setInstalling] = useState<number | null>(null);
  const ffmpegPath = useSettingsStore((s) => s.ffmpegPath);
  useEffect(() => {
    if (!isLinuxWebm) return;
    let cancelled = false;
    sniffWebmVideoCodec(resolvedUrl).then((codec) => {
      if (!cancelled) setWebmProbe({ url: resolvedUrl, codec });
    });
    return () => { cancelled = true; };
  }, [isLinuxWebm, resolvedUrl]);

  // Sous Linux, la seule lecture native fiable est le WebM VP8/VP9. Tout le
  // reste passe par ffmpeg.
  //
  // Cette règle a l'air grossière ; elle a été affinée le 17/09 puis rétablie,
  // parce que `canPlayType()` n'est PAS exploitable ici. Il répond « oui » dès
  // qu'un décodeur est enregistré dans GStreamer — `av1dec` pour l'AV1,
  // `avdec_h264` pour le MP4 — et la lecture cale pourtant au bout de deux
  // secondes. Le pire n'est pas l'échec : c'est qu'il est SILENCIEUX. Aucune
  // erreur sur l'élément, donc `onError` ne part jamais et le repli vers la
  // conversion non plus. Un fichier qu'on croyait lisible devient un lecteur
  // mort, sans rien à quoi se raccrocher.
  //
  // Vérifié dans les deux sens : un MP4 H.264/AAC et un WebM AV1 déclarés
  // lisibles s'arrêtent tous deux à ~2 s, alors que les mêmes fichiers
  // convertis en VP9/Opus et servis par le serveur média local se lisent
  // intégralement.
  // Plus rien n'est converti d'office, sauf un codec dont on ignore tout.
  //
  // La cause des blocages n'était aucun de ceux qu'on a soupçonnés — ni le
  // codec, ni le conteneur, ni la résolution, ni le transport : le modèle de
  // cache `DocumentViewer` que l'application imposait à WebKit désactivait
  // complètement son cache de ressources, donc toute lecture média s'arrêtait
  // après les deux secondes tenues en mémoire. Corrigé dans `lib.rs`.
  //
  // L'AV1 et les codecs inconnus restent convertis d'office, et ce n'est pas de
  // la prudence de principe : essayé le 17/09, la lecture native d'un WebM AV1
  // a tué le processus web en 43 s —
  //
  //   gst-plugins-good/gst/matroska/matroska-demux.c:2429:
  //   gst_matroska_demux_search_cluster: assertion failed
  //   Bail out!
  //
  // Ce n'est pas le décodeur qui lâche mais le démultiplexeur Matroska, et
  // `Bail out!` abat le processus : aucun `onError`, aucun chien de garde,
  // aucun garde-fou côté page n'intercepte ça. La seule protection est de ne
  // jamais lui donner ce fichier à ouvrir.
  //
  // Tout le reste — H.264, VP8, VP9, y compris VP9 dans un conteneur MP4 — se
  // lit nativement depuis que le cache de ressources de WebKit est rétabli
  // (voir `lib.rs`), et le chien de garde ci-dessous rattrape les blocages
  // silencieux.
  // La présence de dav1d était interrogée ici pour décider de lire l'AV1
  // directement. La question n'a plus d'objet : le risque ne venait pas du
  // décodeur mais du conteneur, et il se pose pour tout WebM. dav1d reste
  // embarqué et utile — c'est lui qui décode l'AV1 une fois le fichier remuxé
  // en MP4, et nos propres envois sont déjà dans ce conteneur.
  // Tout WebM est normalisé avant lecture sous Linux — mais par un simple
  // changement de conteneur, pas par un réencodage (voir `remux_video_mp4`).
  //
  // La lecture directe d'un WebM passe par `matroskademux`, dont une assertion
  // a emporté le processus web de WebKit et figé toute l'interface (17/09).
  // Rien, avant d'ouvrir un fichier, ne distingue celui qui se lira de celui
  // qui abattra l'application ; et comme le remux ne coûte ni qualité ni temps
  // notable, il n'y a pas de raison de prendre le risque au cas par cas.
  // L'AV1 reste de l'AV1, ce qui était la demande.
  const mustTranscodeBeforePlayback = isLinuxDesktop && webmCodec !== "pending";
  // Rien n'est converti tant que personne n'a demandé à lire. Une conversion
  // `libvpx-vp9` coûte plusieurs minutes de CPU : la lancer au défilement, pour
  // une vidéo que l'utilisateur ne regardera peut-être jamais, était du travail
  // pur perte — et plusieurs cartes visibles en même temps les lançaient toutes.
  const [playRequested, setPlayRequested] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Codec visé par la conversion. VP9 d'abord ; VP8 seulement après un échec de
  // décodage, voir `handleTranscodedError`.
  const [codec, setCodec] = useState<"vp9" | "vp8">("vp9");

  const handleError = () => {
    // Native playback failed — transcode to WebM via ffmpeg
    if (transcoding || transcodedUrl || error) return;
    if (!attachment.url) { setError("URL manquante"); return; }
    runTranscode();
  };

  // Le fichier converti existe mais la balise n'arrive pas à le lire. Sans ce
  // gestionnaire l'erreur était avalée (`onError` valait `undefined` dès qu'une
  // conversion avait réussi) et la carte affichait un rectangle noir sans
  // contrôles, impossible à distinguer d'une vidéo vide.
  const handleTranscodedError = (ev?: React.SyntheticEvent<HTMLVideoElement>) => {
    if (error) return;
    // Relevé au moment exact de l'échec : la sonde différée arrive trop tard,
    // l'élément est déjà démonté. Le code distingue les cas qui n'appellent pas
    // le même correctif — 3 = décodage (flux illisible en cours de route),
    // 4 = source/format refusé d'emblée.
    const el = ev?.currentTarget;
    const detail = el?.error
      ? `code=${el.error.code} message=${el.error.message || "(vide)"}`
      : "aucune erreur exposée";
    const state = el
      ? ` readyState=${el.readyState} networkState=${el.networkState} duration=${el.duration}`
        + ` dims=${el.videoWidth}x${el.videoHeight} t=${el.currentTime}`
      : "";
    void import("@tauri-apps/plugin-log")
      .then(({ error: logError }) => logError(
        `[Sion][vidéo] source convertie illisible (codec=${codec}): ${detail}${state}`,
      ))
      .catch(() => { /* hors Tauri */ });
    // Échec de DÉCODAGE sur une conversion VP9 : le conteneur et les
    // métadonnées étaient bons, c'est le décodeur qui a lâché. On retente une
    // fois en VP8 avant d'abandonner — mesuré sous WebKitGTK, un VP9 portrait
    // 1080x1920 échoue dès la première image alors que le fichier est valide.
    if (el?.error?.code === 2 /* MEDIA_ERR_NETWORK */ || el?.error?.code === 3) {
      if (codec === "vp9") {
        setCodec("vp8");
        setTranscodedUrl(null);
        void runTranscode("vp8");
        return;
      }
    }
    setError(t("chat.videoPlaybackFailed", {
      defaultValue: "Fichier converti illisible par le lecteur",
    }));
  };

  const runTranscode = async (forceCodec?: "vp9" | "vp8") => {
    const target = forceCodec ?? codec;
    setError(null);
    setTranscoding(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Feed ffmpeg the bytes the renderer already resolved — resolvedUrl is a
      // blob that has gone through E2EE decryption + Matrix media auth. Letting
      // Rust re-download attachment.url would have neither (401 on authed media,
      // ciphertext on encrypted channels). Fall back to URL download if the
      // blob can't be read for some reason.
      //
      // Les octets partent en binaire brut (`ArrayBuffer`), plus en base64 : la
      // version précédente transformait une vidéo de 200 Mo en une chaîne de
      // ~270 Mo dans le processus web, à l'aller comme au retour. Rust rend un
      // chemin, que le protocole `asset` sert directement à la balise vidéo —
      // aucun octet ne retraverse l'IPC.
      let stagedPath: string | undefined;
      try {
        const buf = await (await fetch(resolvedUrl)).arrayBuffer();
        const ext = (attachment.name?.split(".").pop() || "bin").toLowerCase();
        stagedPath = await invoke<string>("stage_media", new Uint8Array(buf), {
          headers: { "x-sion-ext": ext },
        });
      } catch (e) {
        console.warn("[Sion] Mise en tampon pour transcodage échouée, fallback download:", e);
      }
      // Remux d'abord : le conteneur change, les flux vidéo sont copiés bit
      // pour bit. C'est ce qui écarte `matroskademux` — dont une assertion a
      // abattu le processus web et gelé toute l'interface (17/09) — pour une
      // seconde de travail au lieu des minutes d'un réencodage, et sans
      // toucher à la qualité. Le transcodage complet reste le filet : le MP4
      // n'accepte pas tous les flux, VP8 notamment.
      let outPath: string;
      try {
        outPath = await invoke<string>("remux_video_mp4", {
          url: attachment.url,
          ffmpegPath,
          inputPath: stagedPath,
        });
      } catch (e) {
        void import("@tauri-apps/plugin-log")
          .then(({ info }) => info(`[Sion][vidéo] remux refusé (${String(e)}) — réencodage`))
          .catch(() => { /* hors Tauri */ });
        outPath = await invoke<string>("transcode_video", {
          url: attachment.url,
          ffmpegPath,
          inputPath: stagedPath,
          codec: target,
        });
      }
      // Le fichier converti est servi en HTTP local, avec requêtes par plage :
      // c'est ce qu'un élément média sait consommer. Un `blob:` l'obligeait à
      // tenir tout le média en mémoire, et au-delà de quelques mégaoctets la
      // lecture s'arrêtait en route sous WebKitGTK — voir `media_server.rs`
      // pour les mesures et les deux approches écartées avant celle-ci.
      // Sans serveur (socket refusée), on retombe sur le blob : dégradé, mais
      // fonctionnel sur les petits fichiers.
      const port = await invoke<number>("media_server_port").catch(() => 0);
      const name = outPath.split("/").pop() ?? "";
      if (port > 0 && name) {
        const mediaUrl = `http://127.0.0.1:${port}/${encodeURIComponent(name)}`;
        // La webview atteint-elle le serveur ? Si `fetch` réussit là où la
        // balise vidéo échoue, le problème est le chargeur média, pas le
        // réseau — c'est le même schéma qu'avec le protocole `asset`.
        const probe = await fetch(mediaUrl, { headers: { Range: "bytes=0-1" } })
          .then((r) => `${r.status} ${r.headers.get("content-type") ?? "?"}`)
          .catch((e) => `échec ${String(e)}`);
        void import("@tauri-apps/plugin-log")
          .then(({ info }) => info(`[Sion][vidéo] source HTTP ${mediaUrl} → ${probe}`))
          .catch(() => { /* hors Tauri */ });
        setTranscodedUrl(mediaUrl);
      } else {
        const { readMediaBytes } = await import("../../services/videoPrepare");
        const webm = await readMediaBytes(outPath, "converti pour la lecture");
        setTranscodedUrl(URL.createObjectURL(new Blob([webm], { type: "video/webm" })));
      }
    } catch (err) {
      console.error("[Sion] Transcodage échoué:", err);
      // La console de la webview ne va pas dans le fichier de journal : sans
      // ça, un échec de lecture n'était diagnosticable que par-dessus l'épaule
      // de l'utilisateur.
      void import("@tauri-apps/plugin-log")
        .then(({ error: logError }) => logError(`[Sion][vidéo] transcodage échoué: ${String(err)}`))
        .catch(() => { /* hors Tauri */ });
      setError(String(err));
      // Surface an "install ffmpeg" affordance on the card if it's missing.
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const p = await invoke<string | null>("detect_ffmpeg");
        setFfmpegMissing(!p);
      } catch { /* not in Tauri */ }
    } finally {
      setTranscoding(false);
    }
  };

  const handleInstallFfmpeg = async () => {
    setInstalling(0);
    try {
      const { installFfmpeg } = await import("../../services/ffmpegInstall");
      await installFfmpeg((pct) => setInstalling(pct));
      setInstalling(null);
      setFfmpegMissing(false);
      runTranscode(); // retry now that ffmpeg is available
    } catch (err) {
      console.error("[Sion] Installation ffmpeg échouée:", err);
      setInstalling(null);
    }
  };

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (!transcodedUrl?.startsWith("blob:")) return;
      // Tracé : si cette révocation tombe pendant la lecture, la source meurt
      // en cours de route et le lecteur rend `MEDIA_ERR_DECODE` — symptôme
      // rigoureusement identique à un fichier corrompu.
      void import("@tauri-apps/plugin-log")
        .then(({ info }) => info(`[Sion][vidéo] blob révoqué: ${transcodedUrl}`))
        .catch(() => { /* hors Tauri */ });
      URL.revokeObjectURL(transcodedUrl);
    };
  }, [transcodedUrl]);

  // Non-WebM formats keep their existing compatibility transcode. On Linux,
  // only legacy AV1/unknown WebMs are normalized; VP8/VP9 keeps direct,
  // immediate playback.
  useEffect(() => {
    if (webmCodec === "pending" || !resolvedUrl || transcodedUrl || transcoding || error) return;
    if (mustTranscodeBeforePlayback && playRequested) {
      runTranscode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedUrl, webmCodec, playRequested]);

  // Chien de garde de la lecture native.
  //
  // Sous WebKitGTK, une lecture peut s'arrêter au bout de deux secondes SANS
  // émettre la moindre erreur : `onError` ne part pas, `canPlayType` avait
  // répondu « oui », et l'utilisateur se retrouve devant un lecteur mort. Vu le
  // 17/09 sur un MP4 H.264/AAC comme sur un WebM AV1 — alors que d'autres MP4
  // se lisent intégralement. Aucun critère ne permet de prédire lequel passera,
  // donc on ne prédit plus : on essaie, et on surveille.
  //
  // Un lecteur qui cale reste reconnaissable : la position n'avance plus alors
  // qu'il n'est ni en pause ni terminé. Trois secondes de position figée
  // déclenchent la conversion, celle-là même qui n'aurait pas dû être imposée
  // aux fichiers qui marchent.
  useEffect(() => {
    if (!isLinuxDesktop || transcodedUrl || transcoding || error) return;
    let last = -1;
    let frozen = 0;
    const timer = setInterval(() => {
      const el = videoRef.current;
      if (!el || el.paused || el.ended || el.readyState < 2) {
        frozen = 0;
        return;
      }
      if (el.currentTime === last) {
        frozen += 1;
        if (frozen >= 3) {
          clearInterval(timer);
          void import("@tauri-apps/plugin-log")
            .then(({ warn }) => warn(
              `[Sion][vidéo] lecture native figée à ${el.currentTime}s sans erreur — conversion`,
            ))
            .catch(() => { /* hors Tauri */ });
          void runTranscode();
        }
        return;
      }
      frozen = 0;
      last = el.currentTime;
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLinuxDesktop, transcodedUrl, transcoding, error, resolvedUrl]);

  // Sonde d'état du lecteur. Une vidéo « bloquée à 0:00 » ne dit rien par
  // elle-même : selon le cas, les métadonnées ne sont pas arrivées
  // (`readyState` 0), la source est en erreur (`error.code`), ou la lecture est
  // simplement refusée par la politique de démarrage automatique. On relève
  // l'état réel deux secondes après l'attachement de la source convertie.
  useEffect(() => {
    const source = transcodedUrl ?? resolvedUrl;
    if (!source) return;
    const timer = setTimeout(() => {
      const el = videoRef.current;
      if (!el) return;
      void import("@tauri-apps/plugin-log")
        .then(({ info }) => info(
          `[Sion][vidéo] état lecteur (${transcodedUrl ? "converti" : "natif"})`
          + ` readyState=${el.readyState} networkState=${el.networkState}`
          + ` duration=${el.duration} dims=${el.videoWidth}x${el.videoHeight}`
          + ` paused=${el.paused} currentTime=${el.currentTime}`
          + ` erreur=${el.error ? `${el.error.code}/${el.error.message}` : "aucune"}`,
        ))
        .catch(() => { /* hors Tauri */ });
    }, 2000);
    return () => clearTimeout(timer);
  }, [transcodedUrl, resolvedUrl]);

  if (error) {
    const handleDownload = () => {
      const a = document.createElement("a");
      a.href = resolvedUrl;
      a.download = attachment.name || "video.mp4";
      a.click();
    };
    return (
      <div style={{
        marginTop: 6, background: 'var(--color-surface-container-high)', borderRadius: 16,
        padding: '16px 20px', width: 520, maxWidth: '100%',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 12,
          background: 'var(--color-primary-container)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {attachment.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 2 }}>
            {ffmpegMissing
              ? `${formatFileSize(attachment.size)} — ffmpeg requis pour lire ce format`
              : `${formatFileSize(attachment.size)} — ${error}`}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
          {ffmpegMissing && (
            <button
              onClick={handleInstallFfmpeg}
              disabled={installing !== null}
              style={{
                padding: '8px 16px', borderRadius: 20, border: 'none',
                background: 'var(--color-primary)', color: 'var(--color-on-primary)',
                fontSize: 12, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
                cursor: installing !== null ? 'default' : 'pointer',
                opacity: installing !== null ? 0.6 : 1,
              }}
            >
              {installing !== null ? `Installation… ${installing}%` : "Installer ffmpeg (~80 Mo)"}
            </button>
          )}
          <button
            onClick={handleDownload}
            style={{
              padding: '8px 16px', borderRadius: 20, border: 'none', fontFamily: 'inherit',
              fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer',
              background: ffmpegMissing ? 'var(--color-surface-container-highest)' : 'var(--color-primary)',
              color: ffmpegMissing ? 'var(--color-on-surface)' : 'var(--color-on-primary)',
            }}
          >
            Télécharger
          </button>
        </div>
      </div>
    );
  }

  // Conversion nécessaire mais pas encore demandée. On garde l'apparence d'un
  // lecteur — un cadre sombre et un gros bouton de lecture — plutôt qu'une
  // carte de fichier : le geste attendu reste « appuyer sur play », la
  // conversion est un détail d'implémentation que l'utilisateur n'a pas à
  // connaître. Elle n'est simplement plus lancée avant ce geste.
  if (mustTranscodeBeforePlayback && !transcodedUrl && !transcoding) {
    return (
      <div style={{ marginTop: 6, background: 'var(--color-surface-container-high)', borderRadius: 16, overflow: 'hidden', width: 520, maxWidth: '100%' }}>
        <button
          type="button"
          onClick={() => setPlayRequested(true)}
          title={t("chat.videoNeedsConvert", { defaultValue: "conversion nécessaire pour lire ce format" })}
          style={{
            position: 'relative', display: 'block', width: '100%', border: 'none', padding: 0,
            aspectRatio: '16 / 9', background: MEDIA_MATTE, cursor: 'pointer',
          }}
        >
          <span style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{
              width: 64, height: 64, borderRadius: '50%',
              background: 'rgba(0,0,0,0.55)', border: `2px solid ${MEDIA_INK}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill={MEDIA_INK} aria-hidden="true">
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
            </span>
          </span>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', fontSize: 12, color: 'var(--color-outline)' }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {attachment.name} — {formatFileSize(attachment.size)}
          </span>
        </div>
      </div>
    );
  }

  // The synchronous guard prevents even a one-frame mount of an AV1/unknown
  // source while codec probing or the effect-triggered transcode is pending.
  if (webmCodec === "pending" || transcoding || (mustTranscodeBeforePlayback && !transcodedUrl)) {
    return (
      <div style={{
        marginTop: 6, background: 'var(--color-surface-container-high)', borderRadius: 16,
        padding: '16px 20px', width: 520, maxWidth: '100%',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 12,
          background: 'var(--color-primary-container)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <div style={{
            width: 20, height: 20, border: '2px solid var(--color-primary)',
            borderTopColor: 'transparent', borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-on-surface)' }}>
            {attachment.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 2 }}>
            {webmCodec === "pending"
              ? t("chat.videoProbing", { defaultValue: "Analyse du format…" })
              : t("chat.videoConverting", { defaultValue: "Conversion en cours…" })}
          </div>
        </div>
      </div>
    );
  }

  const videoSrc = transcodedUrl || resolvedUrl;

  return (
    <div style={{ marginTop: 6, background: 'var(--color-surface-container-high)', borderRadius: 16, overflow: 'hidden', width: 520, maxWidth: '100%' }}>
      <video
        key={videoSrc}
        ref={videoRef}
        // Le fichier converti vient du serveur média local, donc d'une origine
        // différente de la page. Sans cet attribut, la requête part en mode
        // « no-cors » et WebKitGTK refuse la réponse pour un média : le
        // serveur l'a bien servie en 200 video/webm, le lecteur l'a rejetée
        // sans jamais atteindre `readyState=1`. Le serveur répond déjà
        // `Access-Control-Allow-Origin: *`, la requête CORS aboutit donc.
        crossOrigin={transcodedUrl?.startsWith("http") ? "anonymous" : undefined}
        controls
        playsInline
        autoPlay={playRequested && !!transcodedUrl}
        preload={transcodedUrl ? "metadata" : "none"}
        src={videoSrc}
        style={{ width: '100%', maxHeight: 400, display: 'block' }}
        onError={transcodedUrl ? handleTranscodedError : handleError}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', fontSize: 12, color: 'var(--color-outline)' }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {attachment.name} — {formatFileSize(attachment.size)}
        </span>
        <button
          type="button"
          onClick={async () => {
            if (!attachment.url) return;
            const savedPath = await downloadFileToDownloads(attachment.url, attachment.name);
            if (savedPath) {
              useAppStore.getState().markAsDownloaded(attachment.url);
              useAppStore.getState().showDownloadNotification(attachment.name, savedPath);
            }
          }}
          title={t("chat.download", { defaultValue: "Télécharger la vidéo" })}
          style={{
            flexShrink: 0, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
            border: '1px solid var(--color-outline-variant)', background: 'transparent',
            color: 'var(--color-on-surface-variant)', fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
          }}
        >
          {t("chat.download", { defaultValue: "Télécharger" })}
        </button>
      </div>
    </div>
  );
}

/** Encre des contrôles du visualiseur plein écran : posée sur les pixels de
 *  l'image, jamais sur une surface de l'app — donc volontairement neutre et
 *  hors thème (marqué pour le garde anti-couleurs-en-dur). */
const LIGHTBOX_INK = "#fff"; // theme-exempt — contrôles posés sur le média

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  // Fit (default) ↔ real size. Clicking the image toggles; at 100% the
  // overlay scrolls so very large screenshots can actually be read.
  const [zoomed, setZoomed] = useState(false);
  // Fermer avec Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.88)',
        overflow: zoomed ? 'auto' : 'hidden',
        cursor: 'zoom-out',
      }}
    >
      {/* Flex wrapper + `margin: auto` on the img: centers when it fits,
          scrolls from the true top-left when it overflows (a plain flex
          center would clip the top/left edges of oversized images). */}
      <div style={{ minWidth: '100%', minHeight: '100%', display: 'flex' }}>
        <img
          src={src}
          alt={alt}
          onClick={(e) => { e.stopPropagation(); setZoomed((z) => !z); }}
          style={{
            margin: 'auto',
            display: 'block',
            ...(zoomed
              ? { maxWidth: 'none', maxHeight: 'none' }
              : { maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain' as const, borderRadius: 8 }),
            boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
            cursor: zoomed ? 'zoom-out' : 'zoom-in',
          }}
        />
      </div>
      <div
        onClick={(e) => { e.stopPropagation(); setZoomed((z) => !z); }}
        title={zoomed ? "Taille ajustée" : "Taille réelle (100 %)"}
        style={{
          position: 'fixed', top: 'max(env(safe-area-inset-top, 0px), 16px)', left: 16,
          background: 'rgba(255,255,255,0.15)', borderRadius: 18,
          padding: '7px 14px', cursor: 'pointer',
          color: LIGHTBOX_INK, fontSize: 13, fontWeight: 600, userSelect: 'none',
        }}
      >{zoomed ? '100 %' : 'Ajusté'}</div>
      <button
        onClick={onClose}
        style={{
          position: 'fixed', top: 'max(env(safe-area-inset-top, 0px), 16px)', right: 16,
          background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%',
          width: 36, height: 36, cursor: 'pointer',
          color: LIGHTBOX_INK, fontSize: 18, lineHeight: '36px', textAlign: 'center',
        }}
      >✕</button>
    </div>
  );
}

function AttachmentDisplay({ attachment }: { attachment: FileAttachment }) {
  const { t } = useTranslation();
  const isImage = attachment.mimeType.startsWith("image/");
  const isAudio = attachment.mimeType.startsWith("audio/");
  const isVideo = attachment.mimeType.startsWith("video/");
  // Videos are lazy: don't fetch the bytes or transcode until the card is
  // scrolled into view, so opening a channel doesn't download + convert EVERY
  // video at once (only the ones actually looked at).
  const videoRef = useRef<HTMLDivElement>(null);
  const [videoVisible, setVideoVisible] = useState(false);
  useEffect(() => {
    if (!isVideo) return;
    const el = videoRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setVideoVisible(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVideoVisible(true); io.disconnect(); }
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [isVideo]);
  const resolvedUrl = useResolvedUrl(attachment, isVideo ? videoVisible : true);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // Hoisted above any early return: the downstream image/audio/video
  // branches used to return before this line, and the plain-file branch
  // called it conditionally. React's hook-call rule requires identical
  // call order every render, so if an attachment's mimeType ever flips
  // between "file" and "image" across renders (e.g. late metadata arrival
  // or a new event replacing the placeholder payload), hook count would
  // diverge and throw React #300. Keeping it at the top makes the hook
  // unconditional and costs us nothing for the branches that don't
  // consume `isDownloaded`.
  const isDownloaded = useAppStore((s) => attachment.url ? s.downloadedFiles.has(attachment.url) : false);

  if (isImage) {
    if (!resolvedUrl) {
      return (
        <div style={{ marginTop: 6, padding: '8px 12px', borderRadius: 12, background: 'var(--color-surface-container-high)', color: 'var(--color-outline)', fontSize: 12 }}>
          Chargement de l'image…
        </div>
      );
    }
    return (
      <>
        <img
          src={resolvedUrl}
          alt={attachment.name}
          onClick={() => setLightboxOpen(true)}
          style={{ maxWidth: 300, maxHeight: 200, borderRadius: 16, objectFit: 'cover' as const, cursor: 'zoom-in', marginTop: 6, display: 'block' }}
        />
        {lightboxOpen && (
          <ImageLightbox src={resolvedUrl} alt={attachment.name} onClose={() => setLightboxOpen(false)} />
        )}
      </>
    );
  }

  if (isAudio && resolvedUrl) {
    return (
      <div style={{ marginTop: 6, background: 'var(--color-surface-container-high)', borderRadius: 16, padding: '12px 16px', width: 480, maxWidth: '100%' }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-on-surface)', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {attachment.name}
          <span style={{ color: 'var(--color-outline)', fontWeight: 400, marginLeft: 8 }}>{formatFileSize(attachment.size)}</span>
        </div>
        <audio controls preload="auto" src={resolvedUrl} style={{ width: '100%', height: 44 }} />
      </div>
    );
  }

  if (isVideo) {
    if (!resolvedUrl) {
      return (
        <div ref={videoRef} style={{ marginTop: 6, padding: '8px 12px', borderRadius: 12, background: 'var(--color-surface-container-high)', color: 'var(--color-outline)', fontSize: 12 }}>
          {videoVisible ? "Chargement de la vidéo…" : `🎥 ${attachment.name} — ${formatFileSize(attachment.size)}`}
        </div>
      );
    }
    return <VideoPlayer resolvedUrl={resolvedUrl} attachment={attachment} />;
  }

  const handleOpen = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!attachment.url) return;
    openFileWithDefaultApp(attachment.url, attachment.name);
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!attachment.url) return;
    const savedPath = await downloadFileToDownloads(attachment.url, attachment.name);
    if (savedPath) {
      useAppStore.getState().markAsDownloaded(attachment.url);
      useAppStore.getState().showDownloadNotification(attachment.name, savedPath);
    }
  };

  return (
    <div
      onClick={resolvedUrl ? handleOpen : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: 'var(--color-surface-container-high)', borderRadius: 12,
        padding: '10px 14px', marginTop: 6,
        opacity: resolvedUrl ? 1 : 0.5,
        cursor: resolvedUrl ? 'pointer' : 'default',
      }}
    >
      <FileIcon />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <span style={{ color: 'var(--color-primary)', fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.name}</span>
        <span style={{ color: 'var(--color-outline)', fontSize: 10 }}>{formatFileSize(attachment.size)}</span>
      </div>
      {resolvedUrl && (
        <button
          onClick={handleDownload}
          title={isDownloaded ? t("download.alreadySaved") : t("download.save")}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: isDownloaded ? 'var(--color-success)' : 'var(--color-outline)',
            padding: 4, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            position: 'relative',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = isDownloaded ? 'var(--color-success-hover)' : 'var(--color-primary)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = isDownloaded ? 'var(--color-success)' : 'var(--color-outline)')}
        >
          <DownloadIcon />
          {isDownloaded && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{
              position: 'absolute', bottom: 0, right: -2,
              color: 'var(--color-success)',
              background: 'var(--color-surface-container-high)',
              borderRadius: '50%',
              padding: 1,
            }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}

interface MessageProps {
  message: ChatMessage;
  showHeader: boolean;
  isFirst: boolean;
  highlighted?: boolean;
}

export const Message = React.memo(function Message({ message, showHeader, isFirst, highlighted }: MessageProps) {
  const { t } = useTranslation();
  const currentUserId = useMatrixStore((s) => s.currentUserId);
  const deleteMessage = useMatrixStore((s) => s.deleteMessage);
  const activeChannel = useAppStore((s) => s.activeChannel);
  const setEditingMessage = useAppStore((s) => s.setEditingMessage);
  const setReplyingTo = useAppStore((s) => s.setReplyingTo);
  const isOwnMessage = currentUserId && message.senderId ? message.senderId === currentUserId : false;

  const [isHovered, setIsHovered] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const reactionPickerRef = useRef<HTMLDivElement>(null);
  /** Anchor side chosen dynamically at open time based on available space
   *  between the reaction button and the viewport edges. "left" means the
   *  picker's left edge pins to the button's left edge (picker extends
   *  rightward); "right" is the mirror. Picked statically from
   *  `isOwnMessage` was a blind guess that broke in narrow layouts and for
   *  short messages where the button's actual position didn't track the
   *  bubble's side — measure the DOM instead. */
  const [reactionPickerSide, setReactionPickerSide] = useState<"left" | "right">(isOwnMessage ? "right" : "left");
  const [showUserPopover, setShowUserPopover] = useState(false);
  const userPopoverRef = useRef<HTMLDivElement>(null);

  // Close reaction picker / user popover on outside click
  useEffect(() => {
    if (!showReactionPicker && !showUserPopover) return;
    const handleClick = (e: MouseEvent) => {
      if (showReactionPicker && reactionPickerRef.current && !reactionPickerRef.current.contains(e.target as Node)) {
        setShowReactionPicker(false);
      }
      if (showUserPopover && userPopoverRef.current && !userPopoverRef.current.contains(e.target as Node)) {
        setShowUserPopover(false);
      }
    };
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [showReactionPicker, showUserPopover]);

  const myPowerLevel = activeChannel ? matrixService.getUserPowerLevel(activeChannel) : 0;
  const targetPowerLevel = activeChannel && message.senderId ? matrixService.getMemberPowerLevel(activeChannel, message.senderId) : 0;
  const canModerateUser = myPowerLevel >= 50 && myPowerLevel > targetPowerLevel;
  const canChangeRole = myPowerLevel >= 100 && myPowerLevel > targetPowerLevel;
  const [popoverLoading, setPopoverLoading] = useState(false);

  const handleOpenDM = async () => {
    if (!message.senderId || isOwnMessage) return;
    setShowUserPopover(false);
    try {
      const roomId = await matrixService.createOrGetDMRoom(message.senderId);
      useAppStore.getState().setActiveChannel(roomId, false);
    } catch (err) {
      console.error("[Sion] Failed to open DM:", err);
    }
  };

  const handlePoke = async () => {
    if (!message.senderId || isOwnMessage) return;
    setShowUserPopover(false);
    try {
      const roomId = await matrixService.createOrGetDMRoom(message.senderId);
      await matrixService.sendPoke(roomId);
    } catch (err) {
      console.error("[Sion] Failed to poke:", err);
    }
  };

  const handleKickRoom = async () => {
    if (!activeChannel || !message.senderId || popoverLoading) return;
    setPopoverLoading(true);
    try {
      await matrixService.kickUser(activeChannel, message.senderId);
      setShowUserPopover(false);
    } catch (err) {
      console.error("[Sion] Failed to kick:", err);
    } finally { setPopoverLoading(false); }
  };

  const handleBan = async () => {
    if (!activeChannel || !message.senderId || popoverLoading) return;
    setPopoverLoading(true);
    try {
      await matrixService.banUser(activeChannel, message.senderId);
      setShowUserPopover(false);
    } catch (err) {
      console.error("[Sion] Failed to ban:", err);
    } finally { setPopoverLoading(false); }
  };

  const handleSetRole = async (level: number) => {
    if (!activeChannel || !message.senderId || popoverLoading) return;
    setPopoverLoading(true);
    try {
      await matrixService.setUserPowerLevel(activeChannel, message.senderId, level);
      setShowUserPopover(false);
    } catch (err) {
      console.error("[Sion] Failed to set role:", err);
    } finally { setPopoverLoading(false); }
  };

  const canModerate = activeChannel
    ? matrixService.getUserPowerLevel(activeChannel) >= matrixService.getStatePowerLevel(activeChannel)
    : false;
  const canDelete = isOwnMessage || canModerate;

  const handleEdit = () => {
    const eventId = message.eventId || String(message.id);
    setEditingMessage({ eventId, text: message.text });
  };

  const handleDelete = () => {
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    setShowDeleteConfirm(false);
    const evtId = message.eventId || String(message.id);
    deleteMessage(activeChannel, evtId);
  };

  const cancelDelete = () => {
    setShowDeleteConfirm(false);
  };

  // Auto-cancel the inline confirmation when the user moves the mouse away
  // from the message — same hover-out behaviour as the rest of the action bar.
  useEffect(() => {
    if (!showDeleteConfirm) return;
    if (!isHovered) {
      const t = setTimeout(() => setShowDeleteConfirm(false), 400);
      return () => clearTimeout(t);
    }
  }, [showDeleteConfirm, isHovered]);

  const handleReply = () => {
    setReplyingTo({
      eventId: message.eventId || String(message.id),
      senderId: message.senderId || "",
      user: message.user,
      text: message.text,
    });
  };

  const handlePin = async () => {
    const eventId = message.eventId || String(message.id);
    try {
      await matrixService.pinMessage(activeChannel, eventId);
    } catch (err) {
      console.error("[Sion] Failed to pin message:", err);
    }
  };

  const handleReaction = async (emoji: string) => {
    const eventId = message.eventId || String(message.id);
    setShowReactionPicker(false);
    try {
      // Check if we already reacted with this emoji — if so, remove it
      const reaction = message.reactions?.find((r) => r.emoji === emoji);
      const ownReactionEvtId = currentUserId && reaction?.eventIds?.[currentUserId];
      if (ownReactionEvtId && ownReactionEvtId.startsWith("$")) {
        await matrixService.redactMessage(activeChannel, ownReactionEvtId);
      } else {
        await matrixService.sendReaction(activeChannel, eventId, emoji);
      }
    } catch (err) {
      console.error("[Sion] Failed to toggle reaction:", err);
    }
  };

  const actionButtonStyle: React.CSSProperties = {
    padding: 6,
    border: 'none',
    borderRadius: 8,
    background: 'transparent',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    color: 'var(--color-on-surface-variant)',
    transition: 'background 150ms',
  };

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
      display: 'flex',
      flexDirection: isOwnMessage ? 'row-reverse' : 'row',
      alignItems: 'flex-end',
      gap: 8,
      minWidth: 0,
      marginTop: showHeader ? (isFirst ? 0 : 20) : 4,
      borderRadius: 16,
      padding: highlighted ? '4px 8px' : undefined,
      background: highlighted ? 'var(--color-primary-container)' : undefined,
      transition: 'background 500ms',
    }}>
      {/* Avatar */}
      {showHeader ? (
        <div
          style={{ flexShrink: 0, cursor: isOwnMessage ? 'default' : 'pointer', position: 'relative' }}
          onClick={() => { if (!isOwnMessage) setShowUserPopover((v) => !v); }}
        >
          <UserAvatar name={message.user} speaking={false} size="md" avatarUrl={message.avatarUrl} />
          {/* User popover */}
          {showUserPopover && !isOwnMessage && (
            <div ref={userPopoverRef} style={{
              position: 'absolute',
              top: 0,
              left: 44,
              zIndex: 200,
              background: 'var(--color-surface-container)',
              borderRadius: 16,
              padding: 12,
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
              minWidth: 180,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <UserAvatar name={message.user} speaking={false} size="md" avatarUrl={message.avatarUrl} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)' }}>{message.user}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>{message.senderId}</div>
                </div>
              </div>
              {(() => {
                const btnStyle: React.CSSProperties = {
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '8px 12px', borderRadius: 10, border: 'none',
                  background: 'transparent', color: 'var(--color-on-surface)',
                  cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                  transition: 'background 150ms',
                };
                const targetRole = targetPowerLevel >= 100 ? 'admin' : targetPowerLevel >= 50 ? 'moderator' : 'user';
                return (<>
                  {/* DM */}
                  <button onClick={handleOpenDM} style={{ ...btnStyle, background: 'var(--color-primary)', color: 'var(--color-on-primary)', fontWeight: 500 }}
                    onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                  >
                    <MessageBubbleIcon /> Message
                  </button>
                  {/* Poke */}
                  <button onClick={handlePoke} style={btnStyle}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    👉 Poke
                  </button>

                  {/* Moderation */}
                  {canModerateUser && (<>
                    <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '4px 0' }} />
                    <button onClick={handleKickRoom} disabled={popoverLoading} style={{ ...btnStyle, opacity: popoverLoading ? 0.5 : 1 }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >{t("contextMenu.kickRoom")}</button>
                    <button onClick={handleBan} disabled={popoverLoading} style={{ ...btnStyle, color: 'var(--color-error)', opacity: popoverLoading ? 0.5 : 1 }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-error-container)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >{t("contextMenu.ban")}</button>
                  </>)}

                  {/* Role change */}
                  {canChangeRole && (<>
                    <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '4px 0' }} />
                    <div style={{ padding: '4px 12px 2px', fontSize: 10, color: 'var(--color-outline)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {t("contextMenu.changeRole")}
                    </div>
                    {([['user', 0], ['moderator', 50]] as const).map(([role, level]) => (
                      <button key={role} onClick={() => handleSetRole(level)} disabled={popoverLoading || targetRole === role}
                        style={{ ...btnStyle, fontWeight: targetRole === role ? 600 : 400, color: targetRole === role ? 'var(--color-primary)' : 'var(--color-on-surface)', cursor: targetRole === role ? 'default' : 'pointer' }}
                        onMouseEnter={(e) => { if (targetRole !== role) e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        {role === 'moderator' ? t("contextMenu.roleModerator") : t("contextMenu.roleUser")}
                        {targetRole === role && ' ✓'}
                      </button>
                    ))}
                  </>)}
                </>);
              })()}
            </div>
          )}
        </div>
      ) : (
        <div style={{ width: 36, flexShrink: 0 }} />
      )}

      {/* Contenu */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isOwnMessage ? 'flex-end' : 'flex-start',
        maxWidth: '70%',
        minWidth: 0,
      }}>
        {/* Nom seul (Telegram-style: l'heure est rendue à l'intérieur de
            chaque bulle, pas en tête de groupe). */}
        {showHeader && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 4,
            flexDirection: isOwnMessage ? 'row-reverse' : 'row',
            padding: isOwnMessage ? '0 4px 0 0' : '0 0 0 4px',
          }}>
            <span
              style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: isOwnMessage ? 'default' : 'pointer' }}
              onClick={() => { if (!isOwnMessage) setShowUserPopover((v) => !v); }}
            >
              {roleIcon(message.role)}
              <span style={{ fontWeight: 600, color: roleColor(message.role), fontSize: 12, letterSpacing: '0.01em' }}>
                {message.user}
              </span>
            </span>
          </div>
        )}

        {/* M3 Bubble — surface-container-high pour les autres, primary-container pour soi */}
        <div style={{
          background: isOwnMessage ? 'var(--color-primary-container)' : 'var(--color-surface-container-high)',
          color: isOwnMessage ? 'var(--color-on-primary-container)' : 'var(--color-on-surface)',
          borderRadius: isOwnMessage
            ? (showHeader ? '20px 20px 4px 20px' : '20px 4px 4px 20px')
            : (showHeader ? '20px 20px 20px 4px' : '4px 20px 20px 4px'),
          // Extra bottom padding reserves a quiet band for the absolute-
          // positioned timestamp below. Horizontal padding is untouched so
          // text still ends at the normal right edge — the timestamp sits
          // below in the dedicated 20px strip and never overlaps content.
          padding: message.replyTo ? '8px 8px 20px 8px' : '10px 16px 20px 16px',
          fontSize: 14,
          lineHeight: 1.55,
          wordBreak: 'break-word' as const,
          letterSpacing: '0.01em',
          maxWidth: '100%',
          boxSizing: 'border-box' as const,
          overflow: 'hidden',
          position: 'relative',
        }}>
          {/* Reply quote — Telegram-style, inside bubble */}
          {message.replyTo && (() => {
            // Build a human-readable preview of the quoted message.
            // Prefer the actual text; otherwise fall back to a type-specific
            // hint so replies to images/files/etc. don't show a useless "...".
            const r = message.replyTo;
            const trimmed = r.text?.trim();
            let previewText: string;
            if (trimmed) {
              previewText = trimmed.slice(0, 150);
            } else {
              switch (r.msgtype) {
                case "m.image": previewText = `📷 ${r.attachmentName || "Image"}`; break;
                case "m.video": previewText = `🎥 ${r.attachmentName || "Vidéo"}`; break;
                case "m.audio": previewText = `🎵 ${r.attachmentName || "Audio"}`; break;
                case "m.file":  previewText = `📎 ${r.attachmentName || "Fichier"}`; break;
                case "m.poke":  previewText = "👉 Poke"; break;
                default:        previewText = r.attachmentName || "…";
              }
            }
            return (
            <div
              onClick={() => {
                if (r.eventId) {
                  useAppStore.getState().setScrollToMessageId(r.eventId);
                }
              }}
              style={{
                display: 'flex',
                borderRadius: 10,
                padding: '5px 10px',
                marginBottom: 6,
                cursor: r.eventId ? 'pointer' : 'default',
                background: isOwnMessage ? 'rgba(0,0,0,0.1)' : 'var(--color-surface-container)',
                overflow: 'hidden',
                transition: 'background 150ms',
                // Keep the quote readable even when the reply text is tiny
                minWidth: 180,
              }}
              onMouseEnter={(e) => { if (r.eventId) e.currentTarget.style.background = isOwnMessage ? 'rgba(0,0,0,0.15)' : 'var(--color-surface-container-high)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = isOwnMessage ? 'rgba(0,0,0,0.1)' : 'var(--color-surface-container)'; }}
            >
              <div style={{
                width: 3,
                minHeight: '100%',
                borderRadius: 2,
                background: 'var(--color-primary)',
                marginRight: 8,
                flexShrink: 0,
              }} />
              <div style={{ overflow: 'hidden', minWidth: 0 }}>
                {r.user && (
                  <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--color-primary)', lineHeight: 1.3 }}>
                    {r.user}
                  </div>
                )}
                <div style={{
                  fontSize: 12,
                  color: isOwnMessage ? 'var(--color-on-primary-container)' : 'var(--color-on-surface-variant)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  opacity: 0.8,
                  lineHeight: 1.3,
                }}>
                  {previewText}
                </div>
              </div>
            </div>
            );
          })()}
          <div style={message.replyTo ? { padding: '0 8px' } : undefined}>
          {message.poll ? (
            <PollMessage
              poll={message.poll}
              pollEventId={message.eventId || String(message.id)}
              roomId={activeChannel || ""}
              currentUserId={currentUserId || ""}
              canEnd={isOwnMessage || myPowerLevel >= 50}
            />
          ) : (<>
          <MarkdownRenderer content={message.text} formattedBody={message.formattedBody} msgtype={message.msgtype} />
          {(() => {
            // Strip code blocks and inline code before searching for URLs
            const textWithoutCode = message.text
              ?.replace(/```[\s\S]*?```/g, "")
              .replace(/`[^`]*`/g, "");
            const urlMatch = textWithoutCode?.match(/https?:\/\/\S+/);
            return urlMatch ? <LinkPreview url={urlMatch[0].replace(/[)>\].,;!?]+$/, "")} /> : null;
          })()}
          {message.edited && (
            <span style={{ fontSize: 10, color: 'var(--color-outline)', marginLeft: 4, fontStyle: 'italic' }}>
              ({t("chat.edited")})
            </span>
          )}
          </>)}
          {/* Pièces jointes — inside the bubble */}
          {message.attachments && message.attachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginTop: 4 }}>
              {message.attachments.map((att) => (
                <AttachmentDisplay key={att.id} attachment={att} />
              ))}
            </div>
          )}
          </div>
          {/* Telegram-style in-bubble timestamp: absolute bottom-right, in
              the padding band reserved above. `pointerEvents: none` keeps
              the timestamp from interfering with clicks on the bubble. */}
          <span style={{
            position: 'absolute',
            bottom: 4,
            right: 10,
            fontSize: 10,
            color: isOwnMessage ? 'var(--color-on-primary-container)' : 'var(--color-outline)',
            opacity: 0.65,
            userSelect: 'none',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}>
            {message.time}
          </span>
        </div>

        {/* Reactions display */}
        {message.reactions && message.reactions.length > 0 && (
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
            marginTop: 4,
            padding: '0 4px',
          }}>
            {message.reactions.map((r) => {
              const isMine = currentUserId ? r.userIds.includes(currentUserId) : false;
              return (
                <button
                  key={r.emoji}
                  onClick={() => handleReaction(r.emoji)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    borderRadius: 12,
                    border: isMine ? '1.5px solid var(--color-primary)' : '1.5px solid var(--color-outline-variant)',
                    background: isMine ? 'var(--color-primary-container)' : 'var(--color-surface-container-high)',
                    cursor: 'pointer',
                    fontSize: 13,
                    transition: 'all 150ms',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = isMine ? 'var(--color-primary-container)' : 'var(--color-secondary-container)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = isMine ? 'var(--color-primary-container)' : 'var(--color-surface-container-high)'; }}
                  title={r.userIds.join(', ')}
                >
                  <span style={{ fontSize: 16 }}>{r.emoji}</span>
                  <span style={{ fontSize: 11, color: isMine ? 'var(--color-primary)' : 'var(--color-on-surface-variant)', fontWeight: isMine ? 600 : 400 }}>{r.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Hover action bar — outside: right for others, left for own */}
      {(isHovered || showReactionPicker) && (
        <div style={{
          display: 'flex',
          gap: 2,
          background: 'var(--color-surface-container-high)',
          borderRadius: 12,
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          padding: 2,
          alignSelf: 'flex-end',
          flexShrink: 0,
          position: 'relative',
        }}>
          {/* Reaction emoji button + picker */}
          <div ref={reactionPickerRef} style={{ position: 'relative', display: 'flex' }}>
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                const willOpen = !showReactionPicker;
                if (willOpen) {
                  // Decide anchor side from actual viewport geometry rather
                  // than the isOwnMessage proxy: 320 px picker needs to fit
                  // to one side of the button. Prefer rightward expansion
                  // when it fits; fall back to leftward otherwise.
                  const anchor = reactionPickerRef.current;
                  const PICKER_WIDTH = 320;
                  const EDGE_MARGIN = 8; // small breathing room from the edge
                  if (anchor) {
                    const rect = anchor.getBoundingClientRect();
                    const spaceRight = window.innerWidth - rect.left - EDGE_MARGIN;
                    const spaceLeft = rect.right - EDGE_MARGIN;
                    if (spaceRight >= PICKER_WIDTH) {
                      setReactionPickerSide("left");   // extend right
                    } else if (spaceLeft >= PICKER_WIDTH) {
                      setReactionPickerSide("right");  // extend left
                    } else {
                      // Neither side has enough space → pick the side with
                      // more room; picker will clip slightly but stay as in-
                      // view as possible. Extremely narrow windows only.
                      setReactionPickerSide(spaceRight >= spaceLeft ? "left" : "right");
                    }
                  }
                }
                setShowReactionPicker((v) => !v);
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
              onMouseLeave={(e) => { if (!showReactionPicker) e.currentTarget.style.background = 'transparent'; }}
              style={{ ...actionButtonStyle, background: showReactionPicker ? 'var(--color-secondary-container)' : 'transparent' }}
              title={t("chat.react")}
            >
              <EmojiIcon />
            </button>
            {showReactionPicker && (
              <div style={{
                position: 'absolute',
                bottom: '100%',
                left: reactionPickerSide === "left" ? 0 : undefined,
                right: reactionPickerSide === "right" ? 0 : undefined,
                marginBottom: 4,
                width: 320,
                height: 360,
                background: 'var(--color-surface-container)',
                borderRadius: 16,
                boxShadow: '0 -4px 24px rgba(0,0,0,0.3)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                zIndex: 200,
              }}>
                <EmojiGridPanel onPick={handleReaction} emojiSize={34} />
              </div>
            )}
          </div>
          <button
            onClick={handleReply}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            style={actionButtonStyle}
            title={t("chat.reply")}
          >
            <ReplyIcon />
          </button>
          {isOwnMessage && message.text && (
            <button
              onClick={handleEdit}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={actionButtonStyle}
              title={t("chat.editMessage")}
            >
              <PencilIcon />
            </button>
          )}
          {canModerate && (
            <button
              onClick={handlePin}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={actionButtonStyle}
              title={t("chat.pinMessage")}
            >
              <PinIcon />
            </button>
          )}
          {canDelete && !showDeleteConfirm && (
            <button
              onClick={handleDelete}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-error-container)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={{ ...actionButtonStyle, color: 'var(--color-error)' }}
              title={t("chat.deleteMessage")}
            >
              <TrashIcon />
            </button>
          )}
          {canDelete && showDeleteConfirm && (
            <>
              <button
                onClick={confirmDelete}
                title={t("chat.deleteMessageConfirm")}
                style={{
                  ...actionButtonStyle,
                  background: 'var(--color-error)',
                  color: 'var(--color-on-error)',
                  fontWeight: 700,
                  fontSize: 13,
                  padding: '6px 10px',
                }}
              >
                ✓
              </button>
              <button
                onClick={cancelDelete}
                title={t("auth.cancel")}
                style={{
                  ...actionButtonStyle,
                  color: 'var(--color-on-surface-variant)',
                  fontWeight: 700,
                  fontSize: 13,
                  padding: '6px 10px',
                }}
              >
                ✗
              </button>
            </>
          )}
        </div>
      )}

    </div>
  );
});
