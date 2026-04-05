import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CrownIcon, ShieldIcon, FileIcon, ReplyIcon, PencilIcon, PinIcon, TrashIcon, EmojiIcon, MessageBubbleIcon } from "../icons";
import { useAdminStore } from "../../stores/useAdminStore";
import { UserAvatar } from "../sidebar/UserAvatar";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { LinkPreview } from "./LinkPreview";
import type { ChatMessage, UserRole, FileAttachment } from "../../types/matrix";
import { createDecryptedObjectUrl } from "../../utils/decryptMedia";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useAppStore } from "../../stores/useAppStore";
import * as matrixService from "../../services/matrixService";
import { EMOJI_GROUPS, EMOJI_BY_GROUP, EMOJI_DATA } from "../../utils/emojiData";

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

/** Résout l'URL affichable d'un attachment — décrypte si E2EE, charge en blob pour vidéo/audio. */
function useResolvedUrl(attachment: FileAttachment): string | null {
  const needsBlob = attachment.mimeType.startsWith("video/") || attachment.mimeType.startsWith("audio/");
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(
    (attachment.encryptedFile || needsBlob) ? null : (attachment.url || null),
  );

  useEffect(() => {
    if (!attachment.url) return;

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
  }, [attachment.url, attachment.encryptedFile, attachment.mimeType, needsBlob]);

  return resolvedUrl;
}

function VideoPlayer({ resolvedUrl, attachment }: { resolvedUrl: string; attachment: FileAttachment }) {
  const [transcodedUrl, setTranscodedUrl] = useState<string | null>(null);
  const [transcoding, setTranscoding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleError = async () => {
    // Native playback failed — transcode to WebM via ffmpeg
    if (transcoding || transcodedUrl || error) return;
    if (!attachment.url) { setError("URL manquante"); return; }

    setTranscoding(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const b64: string = await invoke("transcode_video", { url: attachment.url });
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const blob = new Blob([bytes], { type: "video/webm" });
      const blobUrl = URL.createObjectURL(blob);
      setTranscodedUrl(blobUrl);
    } catch (err) {
      console.error("[Sion] Transcodage échoué:", err);
      setError(String(err));
    } finally {
      setTranscoding(false);
    }
  };

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => { if (transcodedUrl) URL.revokeObjectURL(transcodedUrl); };
  }, [transcodedUrl]);

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
            {formatFileSize(attachment.size)} — Lecture impossible
          </div>
        </div>
        <button
          onClick={handleDownload}
          style={{
            padding: '8px 16px', borderRadius: 20, border: 'none',
            background: 'var(--color-primary)', color: 'var(--color-on-primary)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          Télécharger
        </button>
      </div>
    );
  }

  if (transcoding) {
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
            Transcodage en cours…
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
        controls
        playsInline
        preload="auto"
        src={videoSrc}
        style={{ width: '100%', maxHeight: 400, display: 'block' }}
        onError={transcodedUrl ? undefined : handleError}
      />
      <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--color-outline)' }}>
        {attachment.name} — {formatFileSize(attachment.size)}
      </div>
    </div>
  );
}

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
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
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'zoom-out',
      }}
    >
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '90vw', maxHeight: '90vh',
          objectFit: 'contain', borderRadius: 8,
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
          cursor: 'default',
        }}
      />
      <button
        onClick={onClose}
        style={{
          position: 'absolute', top: 'max(env(safe-area-inset-top, 0px), 16px)', right: 16,
          background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%',
          width: 36, height: 36, cursor: 'pointer',
          color: '#fff', fontSize: 18, lineHeight: '36px', textAlign: 'center',
        }}
      >✕</button>
    </div>
  );
}

function AttachmentDisplay({ attachment }: { attachment: FileAttachment }) {
  const isImage = attachment.mimeType.startsWith("image/");
  const isAudio = attachment.mimeType.startsWith("audio/");
  const isVideo = attachment.mimeType.startsWith("video/");
  const resolvedUrl = useResolvedUrl(attachment);
  const [lightboxOpen, setLightboxOpen] = useState(false);

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
        <div style={{ marginTop: 6, padding: '8px 12px', borderRadius: 12, background: 'var(--color-surface-container-high)', color: 'var(--color-outline)', fontSize: 12 }}>
          Chargement de la vidéo…
        </div>
      );
    }
    return <VideoPlayer resolvedUrl={resolvedUrl} attachment={attachment} />;
  }

  return (
    <a
      href={resolvedUrl || "#"}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: 'var(--color-surface-container-high)', borderRadius: 12,
        padding: '10px 14px', textDecoration: 'none', marginTop: 6,
        opacity: resolvedUrl ? 1 : 0.5,
      }}
    >
      <FileIcon />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ color: 'var(--color-primary)', fontSize: 12, fontWeight: 500 }}>{attachment.name}</span>
        <span style={{ color: 'var(--color-outline)', fontSize: 10 }}>{formatFileSize(attachment.size)}</span>
      </div>
    </a>
  );
}

interface MessageProps {
  message: ChatMessage;
  showHeader: boolean;
  isFirst: boolean;
  highlighted?: boolean;
}

export function Message({ message, showHeader, isFirst, highlighted }: MessageProps) {
  const { t } = useTranslation();
  const currentUserId = useMatrixStore((s) => s.currentUserId);
  const deleteMessage = useMatrixStore((s) => s.deleteMessage);
  const activeChannel = useAppStore((s) => s.activeChannel);
  const setEditingMessage = useAppStore((s) => s.setEditingMessage);
  const setReplyingTo = useAppStore((s) => s.setReplyingTo);
  const isOwnMessage = currentUserId && message.senderId ? message.senderId === currentUserId : false;

  const [isHovered, setIsHovered] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [reactionPickerSearch, setReactionPickerSearch] = useState("");
  const [reactionPickerGroup, setReactionPickerGroup] = useState(0);
  const reactionPickerRef = useRef<HTMLDivElement>(null);
  const [showUserPopover, setShowUserPopover] = useState(false);
  const userPopoverRef = useRef<HTMLDivElement>(null);

  // Close reaction picker / user popover on outside click
  useEffect(() => {
    if (!showReactionPicker && !showUserPopover) return;
    const handleClick = (e: MouseEvent) => {
      if (showReactionPicker && reactionPickerRef.current && !reactionPickerRef.current.contains(e.target as Node)) {
        setShowReactionPicker(false);
        setReactionPickerSearch("");
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
    deleteMessage(activeChannel, String(message.id));
  };

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
    setReactionPickerSearch("");
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

  const filteredReactionEmojis = reactionPickerSearch.length >= 2
    ? (() => {
        const q = reactionPickerSearch.toLowerCase();
        const starts = EMOJI_DATA.filter((e) => e.shortcode.startsWith(q));
        const contains = EMOJI_DATA.filter((e) => !e.shortcode.startsWith(q) && e.shortcode.includes(q));
        return [...starts, ...contains];
      })()
    : (EMOJI_BY_GROUP.get(reactionPickerGroup) || []);

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
        {/* Nom + heure */}
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
            <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>{message.time}</span>
          </div>
        )}

        {/* M3 Bubble — surface-container-high pour les autres, primary-container pour soi */}
        <div style={{
          background: isOwnMessage ? 'var(--color-primary-container)' : 'var(--color-surface-container-high)',
          color: isOwnMessage ? 'var(--color-on-primary-container)' : 'var(--color-on-surface)',
          borderRadius: isOwnMessage
            ? (showHeader ? '20px 20px 4px 20px' : '20px 4px 4px 20px')
            : (showHeader ? '20px 20px 20px 4px' : '4px 20px 20px 4px'),
          padding: message.replyTo ? '8px 8px 10px 8px' : '10px 16px',
          fontSize: 14,
          lineHeight: 1.55,
          wordBreak: 'break-word' as const,
          letterSpacing: '0.01em',
          maxWidth: '100%',
          boxSizing: 'border-box' as const,
          overflow: 'hidden',
        }}>
          {/* Reply quote — Telegram-style, inside bubble */}
          {message.replyTo && (
            <div
              onClick={() => {
                if (message.replyTo?.eventId) {
                  useAppStore.getState().setScrollToMessageId(message.replyTo.eventId);
                }
              }}
              style={{
                display: 'flex',
                borderRadius: 10,
                padding: '5px 10px',
                marginBottom: 6,
                cursor: message.replyTo.eventId ? 'pointer' : 'default',
                background: isOwnMessage ? 'rgba(0,0,0,0.1)' : 'var(--color-surface-container)',
                overflow: 'hidden',
                transition: 'background 150ms',
              }}
              onMouseEnter={(e) => { if (message.replyTo?.eventId) e.currentTarget.style.background = isOwnMessage ? 'rgba(0,0,0,0.15)' : 'var(--color-surface-container-high)'; }}
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
                {message.replyTo.user && (
                  <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--color-primary)', lineHeight: 1.3 }}>
                    {message.replyTo.user}
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
                  {message.replyTo.text?.slice(0, 150) || "..."}
                </div>
              </div>
            </div>
          )}
          <div style={message.replyTo ? { padding: '0 8px' } : undefined}>
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
          {/* Pièces jointes — inside the bubble */}
          {message.attachments && message.attachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginTop: 4 }}>
              {message.attachments.map((att) => (
                <AttachmentDisplay key={att.id} attachment={att} />
              ))}
            </div>
          )}
          </div>
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
              onMouseDown={(e) => { e.preventDefault(); setShowReactionPicker((v) => !v); setReactionPickerSearch(""); setReactionPickerGroup(0); }}
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
                left: isOwnMessage ? undefined : 0,
                right: isOwnMessage ? 0 : undefined,
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
                <div style={{ padding: '10px 10px 6px 10px' }}>
                  <input
                    value={reactionPickerSearch}
                    onChange={(e) => setReactionPickerSearch(e.target.value)}
                    placeholder="Rechercher..."
                    autoFocus
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 12,
                      border: '1px solid var(--color-outline-variant)',
                      background: 'var(--color-surface-container-high)',
                      color: 'var(--color-on-surface)',
                      fontSize: 13,
                      fontFamily: 'inherit',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
                {reactionPickerSearch.length < 2 && (
                  <div style={{
                    display: 'flex',
                    gap: 0,
                    padding: '0 6px',
                    borderBottom: '1px solid var(--color-outline-variant)',
                  }}>
                    {EMOJI_GROUPS.map((g) => (
                      <button
                        key={g.id}
                        onMouseDown={(e) => { e.preventDefault(); setReactionPickerGroup(g.id); }}
                        title={g.label}
                        style={{
                          flex: 1,
                          padding: '6px 0',
                          border: 'none',
                          background: 'transparent',
                          fontSize: 14,
                          cursor: 'pointer',
                          borderBottom: reactionPickerGroup === g.id ? '2px solid var(--color-primary)' : '2px solid transparent',
                          opacity: reactionPickerGroup === g.id ? 1 : 0.5,
                          transition: 'all 150ms',
                        }}
                      >
                        {g.icon}
                      </button>
                    ))}
                  </div>
                )}
                <div style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: '4px 8px 8px 8px',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 2,
                  alignContent: 'flex-start',
                }}>
                  {filteredReactionEmojis.map((entry) => (
                    <button
                      key={entry.shortcode}
                      onMouseDown={(e) => { e.preventDefault(); handleReaction(entry.emoji); }}
                      title={`:${entry.shortcode}:`}
                      style={{
                        width: 34,
                        height: 34,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 20,
                        border: 'none',
                        borderRadius: 8,
                        background: 'transparent',
                        cursor: 'pointer',
                        transition: 'background 100ms',
                        padding: 0,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {entry.emoji}
                    </button>
                  ))}
                </div>
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
          {canDelete && (
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
        </div>
      )}

    </div>
  );
}
