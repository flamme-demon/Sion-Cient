import { useRef, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ScreenIcon, PencilIcon, HashIcon, ArrowLeftIcon } from "../icons";
import { ChannelIcon } from "../sidebar/ChannelIcon";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useIsMobile } from "../../hooks/useIsMobile";
import * as matrixService from "../../services/matrixService";
import { getCurrentRoom } from "../../services/livekitService";

function buildWavePath(amplitude: number, phase: number): string {
  if (amplitude < 0.01) return "M0,10 L400,10";
  // Boost small values: sqrt gives more visible movement at low levels
  const boosted = Math.sqrt(Math.min(amplitude, 1));
  const a = boosted * 9; // max deflection ±9 from center (in 20px height)
  const points: string[] = [`M0,10`];
  for (let i = 0; i < 8; i++) {
    const x1 = i * 50 + 25;
    const x2 = (i + 1) * 50;
    const dir = Math.sin(phase + i * 0.8);
    const cy = 10 + dir * a;
    points.push(`Q${x1},${cy} ${x2},10`);
  }
  return points.join(" ");
}

function VoiceWaveBar() {
  const pathRef = useRef<SVGPathElement>(null);
  const rafRef = useRef<number>(0);
  const phaseRef = useRef(0);
  const smoothLevel = useRef(0);

  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      const room = getCurrentRoom();
      let level = 0;
      if (room) {
        // Check isSpeaking flags + audioLevel
        const local = room.localParticipant;
        if (local.isSpeaking) {
          level = Math.max(level, local.audioLevel ?? 0, 0.5);
        } else if ((local.audioLevel ?? 0) > 0.01) {
          level = Math.max(level, local.audioLevel ?? 0);
        }
        room.remoteParticipants.forEach((p) => {
          if (p.isSpeaking) {
            level = Math.max(level, p.audioLevel ?? 0, 0.5);
          } else if ((p.audioLevel ?? 0) > 0.01) {
            level = Math.max(level, p.audioLevel ?? 0);
          }
        });
      }
      // Smooth: fast attack, slow release
      if (level > smoothLevel.current) {
        smoothLevel.current = level;
      } else {
        smoothLevel.current *= 0.92;
      }
      phaseRef.current += 0.06 + smoothLevel.current * 0.15;
      const path = buildWavePath(smoothLevel.current, phaseRef.current);
      if (pathRef.current) {
        pathRef.current.setAttribute("d", path);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, []);

  return (
    <div style={{ height: 20, overflow: 'hidden', background: 'transparent' }}>
      <svg
        viewBox="0 0 400 20"
        preserveAspectRatio="none"
        style={{ width: '100%', height: '100%', display: 'block' }}
      >
        <path
          ref={pathRef}
          d="M0,10 L400,10"
          fill="none"
          stroke="var(--color-green)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

export function ChatHeader() {
  const { t } = useTranslation();
  const activeChannel = useAppStore((s) => s.activeChannel);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const isScreenSharing = useAppStore((s) => s.isScreenSharing);
  const toggleScreenShare = useAppStore((s) => s.toggleScreenShare);
  const setMobileView = useAppStore((s) => s.setMobileView);
  const channels = useMatrixStore((s) => s.channels);
  const isMobile = useIsMobile();

  const channel = channels.find((c) => c.id === activeChannel);
  const channelName = channel?.name || "general";

  const [showEditModal, setShowEditModal] = useState(false);
  const [editName, setEditName] = useState("");
  const [editTopic, setEditTopic] = useState("");
  const [saving, setSaving] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const canEdit = activeChannel
    ? matrixService.getUserPowerLevel(activeChannel) >= matrixService.getStatePowerLevel(activeChannel)
    : false;

  const openEditModal = () => {
    setEditName(channel?.name || "");
    setEditTopic(channel?.topic || "");
    setAvatarPreview(null);
    setShowEditModal(true);
  };

  const handleAvatarPick = async (file: File) => {
    if (!activeChannel) return;
    setAvatarPreview(URL.createObjectURL(file));
    try {
      await matrixService.setRoomAvatar(activeChannel, file);
    } catch (err) {
      console.error("[Sion] Failed to set avatar:", err);
      setAvatarPreview(null);
    }
  };

  const handleSaveEdit = async () => {
    if (saving || !activeChannel) return;
    setSaving(true);
    try {
      if (editName.trim() && editName.trim() !== channel?.name) {
        await matrixService.setRoomName(activeChannel, editName.trim());
      }
      if (editTopic !== (channel?.topic || "")) {
        await matrixService.setRoomTopic(activeChannel, editTopic);
      }
      setShowEditModal(false);
    } catch (err) {
      console.error("[Sion] Failed to edit channel:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* M3 Top App Bar */}
      <div style={{
        height: isMobile ? 56 : 64,
        minHeight: isMobile ? 56 : 64,
        background: 'var(--color-surface-container)',
        display: 'flex',
        alignItems: 'center',
        padding: isMobile ? '0 12px' : '0 24px',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12, minWidth: 0 }}>
          {isMobile && (
            <button
              onClick={() => setMobileView("sidebar")}
              style={{
                padding: 8,
                borderRadius: 12,
                border: 'none',
                cursor: 'pointer',
                background: 'transparent',
                color: 'var(--color-on-surface)',
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <ArrowLeftIcon />
            </button>
          )}
          <ChannelIcon icon={channel?.icon} />
          <span style={{ fontWeight: 600, fontSize: isMobile ? 15 : 16, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{channelName}</span>
          {canEdit && !isMobile && (
            <button
              onClick={openEditModal}
              style={{
                padding: 6,
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                background: 'transparent',
                color: 'var(--color-on-surface-variant)',
                display: 'flex',
                alignItems: 'center',
                transition: 'background 200ms',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title={t("channels.settings")}
            >
              <PencilIcon />
            </button>
          )}
          {!isMobile && (
            <span style={{ color: 'var(--color-outline)', fontSize: 12, marginLeft: 4 }}>{channel?.topic || t("channels.discussion")}</span>
          )}
        </div>
        {connectedVoice && !isMobile && (
          <button
            onClick={toggleScreenShare}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              borderRadius: 20,
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'inherit',
              letterSpacing: '0.02em',
              transition: 'all 200ms',
              background: isScreenSharing ? 'var(--color-error-container)' : 'var(--color-primary-container)',
              color: isScreenSharing ? 'var(--color-error)' : 'var(--color-on-primary-container)',
            }}
          >
            <ScreenIcon />
            {isScreenSharing ? t("chat.stopShare") : t("chat.shareScreen")}
          </button>
        )}
      </div>

      {isMobile && connectedVoice && <VoiceWaveBar />}

      {isScreenSharing && (
        <div style={{
          background: 'var(--color-error-container)',
          padding: '10px 24px',
          fontSize: 12,
          color: 'var(--color-error)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-error)', display: 'inline-block', animation: 'pulse 1.5s infinite' }} />
          {t("chat.sharingScreen")}
        </div>
      )}

      {showEditModal && (
        <div
          onClick={() => setShowEditModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--color-surface-container)',
              borderRadius: 24,
              padding: isMobile ? '24px 20px 16px 20px' : '28px 28px 20px 28px',
              maxWidth: 400,
              width: '90%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-on-surface)', marginBottom: 16 }}>
              {t("channels.settings")}
            </div>
            <label style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginBottom: 6, display: 'block' }}>
              {t("channels.editName")}
            </label>
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              autoFocus
              style={{
                width: '100%',
                padding: '12px 16px',
                borderRadius: 16,
                border: '2px solid var(--color-outline-variant)',
                background: 'var(--color-surface-container-high)',
                color: 'var(--color-on-surface)',
                fontSize: 14,
                fontFamily: 'inherit',
                outline: 'none',
                marginBottom: 16,
                boxSizing: 'border-box',
              }}
            />
            <label style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginBottom: 6, display: 'block' }}>
              {t("channels.editTopic")}
            </label>
            <input
              value={editTopic}
              onChange={(e) => setEditTopic(e.target.value)}
              style={{
                width: '100%',
                padding: '12px 16px',
                borderRadius: 16,
                border: '2px solid var(--color-outline-variant)',
                background: 'var(--color-surface-container-high)',
                color: 'var(--color-on-surface)',
                fontSize: 14,
                fontFamily: 'inherit',
                outline: 'none',
                marginBottom: 16,
                boxSizing: 'border-box',
              }}
            />
            <label style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginBottom: 8, display: 'block' }}>
              {t("channels.editAvatar")}
            </label>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                style={{
                  position: 'relative',
                  width: 64,
                  height: 64,
                  borderRadius: '50%',
                  border: '2px dashed var(--color-outline-variant)',
                  background: 'var(--color-surface-container-high)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  padding: 0,
                  transition: 'border-color 200ms, background 200ms',
                }}
              >
                {(avatarPreview || channel?.icon) ? (
                  <img
                    src={avatarPreview || channel?.icon}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <HashIcon style={{ width: 24, height: 24, color: 'var(--color-on-surface-variant)' }} />
                )}
                {/* Pencil badge */}
                <div style={{
                  position: 'absolute',
                  bottom: 0,
                  right: 0,
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: 'var(--color-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '2px solid var(--color-surface-container)',
                }}>
                  <PencilIcon style={{ width: 12, height: 12, color: 'var(--color-on-primary)' }} />
                </div>
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleAvatarPick(file);
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowEditModal(false)}
                style={{
                  padding: '10px 20px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: 'var(--color-surface-container-high)',
                  color: 'var(--color-on-surface)',
                }}
              >
                {t("auth.cancel")}
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                style={{
                  padding: '10px 20px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: 'var(--color-primary)',
                  color: 'var(--color-on-primary)',
                  opacity: saving ? 0.5 : 1,
                }}
              >
                {t("channels.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
