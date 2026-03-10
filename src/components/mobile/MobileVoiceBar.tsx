import { useState, useCallback, useRef, useEffect } from "react";
import { MicIcon, HeadphoneIcon, DisconnectIcon } from "../icons";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useVoiceChannel } from "../../hooks/useVoiceChannel";

async function requestMicPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

export const MOBILE_VOICE_BAR_HEIGHT = 120;

export function MobileVoiceBar() {
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const isMuted = useAppStore((s) => s.isMuted);
  const isDeafened = useAppStore((s) => s.isDeafened);
  const toggleMute = useAppStore((s) => s.toggleMute);
  const toggleDeafen = useAppStore((s) => s.toggleDeafen);
  const channels = useMatrixStore((s) => s.channels);
  const { leaveVoiceChannel } = useVoiceChannel();

  const [pttActive, setPttActive] = useState(false);
  const pttTimeout = useRef<ReturnType<typeof setTimeout>>();

  const activeVoice = channels.find((c) => c.id === connectedVoice);

  useEffect(() => {
    if (connectedVoice) {
      requestMicPermission();
    }
  }, [connectedVoice]);

  const setIsSpeaking = useAppStore((s) => s.setIsSpeaking);

  const handlePTTStart = useCallback(() => {
    if (pttTimeout.current) clearTimeout(pttTimeout.current);
    if (isMuted) {
      toggleMute();
    }
    setPttActive(true);
    setIsSpeaking(true);
  }, [isMuted, toggleMute, setIsSpeaking]);

  const handlePTTEnd = useCallback(() => {
    pttTimeout.current = setTimeout(() => {
      if (!useAppStore.getState().isMuted) {
        toggleMute();
      }
      setPttActive(false);
      setIsSpeaking(false);
    }, 200);
  }, [toggleMute, setIsSpeaking]);

  if (!connectedVoice || !activeVoice) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      minHeight: MOBILE_VOICE_BAR_HEIGHT,
      boxSizing: 'border-box',
      background: 'var(--color-surface-container)',
      borderTop: '1px solid var(--color-outline-variant)',
      zIndex: 50,
      display: 'flex',
      flexDirection: 'column',
      paddingBottom: 'max(env(safe-area-inset-bottom), 16px)',
    }}>
      {/* Top row: channel name */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 16px 0',
      }}>
        <span style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--color-green)',
          flexShrink: 0,
          animation: 'pulse 2s infinite',
        }} />
        <span style={{
          fontSize: 11,
          color: 'var(--color-green)',
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {activeVoice.name}
        </span>
      </div>

      {/* Bottom row: controls + PTT + disconnect */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        flex: 1,
        padding: '0 12px 6px',
        gap: 8,
      }}>
        {/* Left: mute/deafen */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, justifyContent: 'flex-start' }}>
          <button
            onClick={toggleMute}
            style={{
              border: 'none', cursor: 'pointer', padding: 8, borderRadius: 12, display: 'flex',
              background: isMuted ? 'var(--color-error-container)' : 'transparent',
              color: isMuted ? 'var(--color-error)' : 'var(--color-on-surface-variant)',
            }}
          >
            <MicIcon muted={isMuted} />
          </button>
          <button
            onClick={toggleDeafen}
            style={{
              border: 'none', cursor: 'pointer', padding: 8, borderRadius: 12, display: 'flex',
              background: isDeafened ? 'var(--color-error-container)' : 'transparent',
              color: isDeafened ? 'var(--color-error)' : 'var(--color-on-surface-variant)',
            }}
          >
            <HeadphoneIcon muted={isDeafened} />
          </button>
        </div>

        {/* Center: PTT */}
        <button
          onTouchStart={handlePTTStart}
          onTouchEnd={handlePTTEnd}
          onTouchCancel={handlePTTEnd}
          onMouseDown={handlePTTStart}
          onMouseUp={handlePTTEnd}
          onMouseLeave={handlePTTEnd}
          style={{
            border: 'none',
            cursor: 'pointer',
            width: 68,
            height: 68,
            borderRadius: '50%',
            flexShrink: 0,
            transition: 'all 150ms',
            background: pttActive ? 'var(--color-primary)' : 'var(--color-surface-container-highest)',
            color: pttActive ? 'var(--color-on-primary)' : 'var(--color-on-surface)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            WebkitUserSelect: 'none',
            userSelect: 'none',
            touchAction: 'none',
            boxShadow: pttActive ? '0 0 20px rgba(168,199,250,0.5)' : '0 2px 8px rgba(0,0,0,0.3)',
          }}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </button>

        {/* Right: disconnect */}
        <div style={{ display: 'flex', alignItems: 'center', flex: 1, justifyContent: 'flex-end' }}>
          <button
            onClick={() => connectedVoice && leaveVoiceChannel(connectedVoice)}
            style={{
              border: 'none',
              cursor: 'pointer',
              padding: 10,
              borderRadius: 12,
              display: 'flex',
              background: 'var(--color-error-container)',
              color: 'var(--color-error)',
            }}
          >
            <DisconnectIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
