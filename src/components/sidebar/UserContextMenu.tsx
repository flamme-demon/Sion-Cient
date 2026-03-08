import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ConnectionQuality } from "livekit-client";
import { getCurrentRoom } from "../../services/livekitService";

interface UserContextMenuProps {
  userId: string;
  userName: string;
  x: number;
  y: number;
  onClose: () => void;
}

function getColor(ms: number) {
  if (ms < 50) return "var(--color-green)";
  if (ms < 150) return "var(--color-yellow)";
  return "var(--color-error)";
}

function qualityColor(q: ConnectionQuality) {
  if (q === ConnectionQuality.Excellent) return "var(--color-green)";
  if (q === ConnectionQuality.Good) return "var(--color-yellow)";
  return "var(--color-error)";
}

function qualityLabel(q: ConnectionQuality) {
  if (q === ConnectionQuality.Excellent) return "Excellent";
  if (q === ConnectionQuality.Good) return "Good";
  if (q === ConnectionQuality.Poor) return "Poor";
  if (q === ConnectionQuality.Lost) return "Lost";
  return "Unknown";
}

function LatencySparkline({ participantIdentity }: { participantIdentity: string }) {
  const { t } = useTranslation();
  const room = getCurrentRoom();
  const isLocal = room?.localParticipant.identity === participantIdentity;

  const [samples, setSamples] = useState<number[]>([]);
  const samplesRef = useRef<number[]>([]);
  const [quality, setQuality] = useState<ConnectionQuality | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const currentRoom = getCurrentRoom();
      if (!currentRoom) return;

      if (isLocal) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = (currentRoom as any)?.engine;
        const rtt = engine?.client?.rtt ?? engine?.rtt ?? null;
        if (rtt != null) {
          samplesRef.current = [...samplesRef.current.slice(-29), rtt];
          setSamples([...samplesRef.current]);
        }
      } else {
        const participant = currentRoom.remoteParticipants.get(participantIdentity);
        if (participant) {
          setQuality(participant.connectionQuality);
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [participantIdentity, isLocal]);

  // Remote participant: show connection quality
  if (!isLocal) {
    if (quality === null) {
      return (
        <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--color-outline)" }}>
          {t("contextMenu.noLatencyData")}
        </div>
      );
    }
    return (
      <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: qualityColor(quality),
        }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: qualityColor(quality) }}>
          {qualityLabel(quality)}
        </span>
      </div>
    );
  }

  // Local participant: show RTT sparkline
  const current = samples.length > 0 ? samples[samples.length - 1] : null;

  if (current === null) {
    return (
      <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--color-outline)" }}>
        {t("contextMenu.noLatencyData")}
      </div>
    );
  }

  const max = Math.max(...samples, 1);
  const width = 140;
  const height = 32;
  const points = samples
    .map((v, i) => {
      const x = (i / 29) * width;
      const y = height - (v / max) * (height - 4);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 10 }}>
      <svg width={width} height={height} style={{ flexShrink: 0 }}>
        <polyline
          points={points}
          fill="none"
          stroke={getColor(current)}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <span style={{ fontSize: 12, fontWeight: 600, color: getColor(current), fontVariantNumeric: "tabular-nums" }}>
        {Math.round(current)} ms
      </span>
    </div>
  );
}

export function UserContextMenu({ userId, userName, x, y, onClose }: UserContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [showLatency, setShowLatency] = useState(false);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 200);
  const adjustedY = Math.min(y, window.innerHeight - 200);

  const itemStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "10px 14px",
    border: "none",
    borderRadius: 8,
    background: "transparent",
    color: "var(--color-on-surface)",
    fontSize: 13,
    fontFamily: "inherit",
    cursor: "pointer",
    textAlign: "left",
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left: adjustedX,
        top: adjustedY,
        zIndex: 9999,
        background: "var(--color-surface-container-high)",
        borderRadius: 12,
        padding: 4,
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        minWidth: 180,
      }}
    >
      {/* User name header */}
      <div style={{ padding: "8px 14px 4px", fontSize: 11, color: "var(--color-outline)", fontWeight: 600 }}>
        {userName}
      </div>

      {/* Latency toggle */}
      <button onClick={() => setShowLatency(!showLatency)} style={itemStyle}>
        {t("contextMenu.latency")}
      </button>

      {showLatency && <LatencySparkline participantIdentity={userId} />}
    </div>
  );
}
