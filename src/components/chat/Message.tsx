import React, { useState, useEffect, useRef, useMemo, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { CrownIcon, ShieldIcon, FileIcon, DownloadIcon, ReplyIcon, PencilIcon, PinIcon, TrashIcon, EmojiIcon, MessageBubbleIcon } from "../icons";
import { UserAvatar } from "../sidebar/UserAvatar";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { PollMessage } from "./PollMessage";
import { LinkPreview as LinkPreviewInner } from "./LinkPreview";

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
// Lecteur hors moteur web (voir docs/lecteur-video-natif.md). Chargé à la
// demande : il ne sert qu'au clic, inutile de l'embarquer au démarrage.
const NativeVideoPlayer = lazy(() =>
  import("./NativeVideoPlayer").then((m) => ({ default: m.NativeVideoPlayer })),
);

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

/**
 * Carte vidéo du fil : une affiche cliquable, jamais de balise `<video>`.
 *
 * Le moteur web ne décode plus rien ici — c'est précisément ce qui a valu
 * quatre jours de contournements, et un utilisateur qui ne voyait qu'un cadre
 * vert sur une vidéo pourtant décodée. Le clic ouvre le lecteur natif, dont
 * l'image passe par la surface du partage d'écran. Voir
 * docs/lecteur-video-natif.md.
 */
function VideoCard({ resolvedUrl, attachment }: { resolvedUrl: string | null; attachment: FileAttachment }) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string | null>(null);
  const [preparation, setPreparation] = useState(false);
  const isDownloaded = useAppStore((s) => (attachment.url ? s.downloadedFiles.has(attachment.url) : false));

  /**
   * Ce que ffmpeg doit ouvrir.
   *
   * Surtout pas l'URL `blob:` que le navigateur fabrique : elle n'existe que
   * dans le moteur web, et ffmpeg répond « format illisible » (21/09). Un
   * média en clair se lit directement par son URL HTTP. Un média chiffré, lui,
   * doit d'abord être déchiffré ici puis déposé dans un fichier temporaire —
   * le serveur ne sert que des octets illisibles.
   */
  const preparerSource = async (): Promise<string | null> => {
    if (!attachment.encryptedFile) return attachment.url || null;
    if (!resolvedUrl) return null;
    setPreparation(true);
    try {
      const octets = new Uint8Array(await (await fetch(resolvedUrl)).arrayBuffer());
      const { invoke } = await import("@tauri-apps/api/core");
      const ext = (attachment.name.split(".").pop() || "mp4").toLowerCase();
      return await invoke<string>("stage_media", octets, { headers: { "x-sion-ext": ext } });
    } catch (err) {
      console.error("[Sion][lecteur] préparation du média chiffré impossible", err);
      return null;
    } finally {
      setPreparation(false);
    }
  };

  return (
    <div style={{ marginTop: 6, maxWidth: 420 }}>
      <div
        onClick={() => { void preparerSource().then(setSource); }}
        style={{
          position: 'relative',
          borderRadius: 16,
          overflow: 'hidden',
          cursor: 'pointer',
          background: 'var(--color-surface-container-high)',
          aspectRatio: attachment.width && attachment.height ? `${attachment.width} / ${attachment.height}` : '16 / 9',
          maxHeight: 240,
        }}
      >
        {/* L'affiche vient du serveur quand l'émetteur en a joint une ; sinon
            la carte reste sobre, avec juste le bouton de lecture. */}
        {attachment.thumbnailUrl && (
          <img
            src={attachment.thumbnailUrl}
            alt={attachment.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            width: 52, height: 52, borderRadius: 26,
            background: 'var(--color-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {preparation ? (
              <span style={{ color: 'var(--color-on-primary)', fontSize: 11 }}>…</span>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="var(--color-on-primary)">
                <polygon points="6 4 20 12 6 20" />
              </svg>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--color-outline)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
          title={isDownloaded ? t("download.alreadySaved") : t("chat.download", { defaultValue: "Télécharger la vidéo" })}
          style={{
            flexShrink: 0, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
            border: '1px solid var(--color-outline-variant)', background: 'transparent',
            color: isDownloaded ? 'var(--color-success)' : 'var(--color-on-surface-variant)',
            fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
          }}
        >
          {t("chat.download", { defaultValue: "Télécharger" })}
        </button>
      </div>

      {source && (
        <Suspense fallback={null}>
          <NativeVideoPlayer
            source={source}
            titre={attachment.name}
            onClose={() => setSource(null)}
          />
        </Suspense>
      )}
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
  // Une vidéo en clair n'est plus téléchargée par le webview : ffmpeg lit
  // l'URL. Seul un média chiffré doit encore passer ici, pour être déchiffré.
  const resolvedUrl = useResolvedUrl(
    attachment,
    isVideo ? videoVisible && !!attachment.encryptedFile : true,
  );
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // Vrai si la vignette du serveur n'a pas pu être chargée.
  const [vignetteEchouee, setVignetteEchouee] = useState(false);
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
          // Vignette dans le fil, original seulement dans la visionneuse.
          //
          // Une image est décodée à sa taille réelle : la photo de 4032×3024
          // affichée ici dans 300×200 occupait 48 Mo de mémoire. 41 images du
          // fil en retenaient 161 à elles seules (20/09). Le serveur sait
          // servir une vignette ; quand il ne le peut pas — média chiffré —
          // on retombe sur l'original, faute de mieux.
          src={vignetteEchouee || attachment.encryptedFile || !attachment.thumbnailUrl
            ? resolvedUrl
            : attachment.thumbnailUrl}
          alt={attachment.name}
          // Un serveur qui ne sait pas produire de vignette ne doit pas coûter
          // l'image : on retombe sur l'original plutôt que d'afficher un cadre
          // vide.
          onError={() => setVignetteEchouee(true)}
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
    return <VideoCard resolvedUrl={resolvedUrl} attachment={attachment} />;
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

  // État d'épinglage, pour que le bouton dise ce qu'il fait.
  //
  // `pinMessage` bascule depuis toujours — elle retire l'épingle si le message
  // y figure — mais l'icône restait identique dans les deux cas : rien
  // n'indiquait qu'un message était déjà épinglé, ni qu'un second clic le
  // désépinglerait (18/09). `pinnedVersion` force la relecture quand les
  // épingles du salon changent, y compris depuis un autre client.
  const pinnedVersion = useMatrixStore((s) => s.pinnedVersion);
  const isPinned = useMemo(() => {
    // Lecture explicite : `pinnedVersion` n'est qu'un compteur, mais c'est lui
    // qui rend cette valeur périmée quand les épingles changent. Le laisser
    // dans les seules dépendances en faisait une dépendance « inutile » aux
    // yeux du lint, alors qu'elle est la seule raison de recalculer.
    void pinnedVersion;
    if (!activeChannel) return false;
    const eventId = message.eventId || String(message.id);
    return matrixService.getPinnedEventIds(activeChannel).includes(eventId);
  }, [activeChannel, message.eventId, message.id, pinnedVersion]);

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
              style={{
                ...actionButtonStyle,
                // Épinglé : couleur d'accent et icône pleine. L'action étant
                // une bascule, l'état doit se lire avant le clic.
                color: isPinned ? 'var(--color-primary)' : actionButtonStyle.color,
              }}
              title={isPinned
                ? t("chat.unpinMessage", { defaultValue: "Désépingler" })
                : t("chat.pinMessage")}
              aria-pressed={isPinned}
            >
              <PinIcon filled={isPinned} />
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
