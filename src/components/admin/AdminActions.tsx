import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as matrixService from "../../services/matrixService";

export function AdminActions() {
  const { t } = useTranslation();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelIsVoice, setNewChannelIsVoice] = useState(false);
  const [creating, setCreating] = useState(false);

  const handleCreateChannel = async () => {
    if (!newChannelName.trim() || creating) return;
    setCreating(true);
    try {
      await matrixService.createChannel(newChannelName.trim(), newChannelIsVoice);
      setShowCreateModal(false);
      setNewChannelName("");
      setNewChannelIsVoice(false);
    } catch (err) {
      console.error("[Sion] Failed to create channel:", err);
    } finally {
      setCreating(false);
    }
  };

  const actions = [
    { label: t("admin.actions.createRoom"), icon: "+", onClick: () => setShowCreateModal(true), enabled: true },
    { label: t("admin.actions.permissions"), icon: "\u{1F6E1}", enabled: false },
    { label: t("admin.actions.logs"), icon: "\u{1F4CB}", enabled: false },
    { label: t("admin.actions.federation"), icon: "\u{1F310}", enabled: false },
    { label: t("admin.actions.configureLivekit"), icon: "\u{1F399}", enabled: false },
    { label: t("admin.actions.purgeCache"), icon: "\u{1F5D1}", enabled: false },
  ];

  return (
    <div style={{
      background: 'var(--color-surface-container)',
      borderRadius: 16,
      padding: '14px 8px',
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase' as const,
        letterSpacing: '0.06em',
        color: 'var(--color-on-surface-variant)',
        marginBottom: 8,
        padding: '0 8px',
      }}>
        {t("admin.actions.title")}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {actions.map((action, i) => (
          <button
            key={i}
            disabled={!action.enabled}
            onClick={action.enabled ? action.onClick : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 28,
              border: 'none',
              background: 'transparent',
              cursor: action.enabled ? 'pointer' : 'default',
              color: 'var(--color-on-surface-variant)',
              opacity: action.enabled ? 1 : 0.4,
              fontSize: 12,
              fontFamily: 'inherit',
              textAlign: 'left' as const,
              transition: 'background 200ms',
              letterSpacing: '0.01em',
            }}
          >
            <span style={{ fontSize: 14, width: 20, textAlign: 'center' as const }}>{action.icon}</span>
            {action.label}
          </button>
        ))}
      </div>

      {showCreateModal && (
        <div
          onClick={() => setShowCreateModal(false)}
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
              padding: '28px 28px 20px 28px',
              maxWidth: 360,
              width: '90%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-on-surface)', marginBottom: 16 }}>
              {t("channels.createTitle")}
            </div>
            <input
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              placeholder={t("channels.channelName")}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateChannel(); }}
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
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <button
                onClick={() => setNewChannelIsVoice(false)}
                style={{
                  flex: 1,
                  padding: '10px 16px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: !newChannelIsVoice ? 'var(--color-primary)' : 'var(--color-surface-container-high)',
                  color: !newChannelIsVoice ? 'var(--color-on-primary)' : 'var(--color-on-surface-variant)',
                  transition: 'all 200ms',
                }}
              >
                {t("channels.typeText")}
              </button>
              <button
                onClick={() => setNewChannelIsVoice(true)}
                style={{
                  flex: 1,
                  padding: '10px 16px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: newChannelIsVoice ? 'var(--color-primary)' : 'var(--color-surface-container-high)',
                  color: newChannelIsVoice ? 'var(--color-on-primary)' : 'var(--color-on-surface-variant)',
                  transition: 'all 200ms',
                }}
              >
                {t("channels.typeVoice")}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setShowCreateModal(false); setNewChannelName(""); }}
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
                  transition: 'background 200ms',
                }}
              >
                {t("auth.cancel")}
              </button>
              <button
                onClick={handleCreateChannel}
                disabled={!newChannelName.trim() || creating}
                style={{
                  padding: '10px 20px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: newChannelName.trim() && !creating ? 'pointer' : 'not-allowed',
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: 'var(--color-primary)',
                  color: 'var(--color-on-primary)',
                  transition: 'background 200ms',
                  opacity: newChannelName.trim() && !creating ? 1 : 0.5,
                }}
              >
                {creating ? t("channels.creating") : t("channels.create")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
