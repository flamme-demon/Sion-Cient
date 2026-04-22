interface UserAvatarProps {
  name: string;
  speaking: boolean;
  size?: "sm" | "md";
  avatarUrl?: string;
  presence?: "online" | "offline" | "unavailable";
  /** Emoji displayed in a badge over the avatar while a soundboard sound is
   *  playing. The soundboard ring replaces the speaking ring when both are
   *  active so the soundboard state stays visible. */
  playingSoundEmoji?: string;
}

export function UserAvatar({ name, speaking, size = "sm", avatarUrl, presence, playingSoundEmoji }: UserAvatarProps) {
  const dim = size === "sm" ? 24 : 36;
  const fontSize = size === "sm" ? 10 : 14;

  // Extract display name initial — use Array.from to handle emoji (surrogate pairs) correctly
  const initial = name.startsWith("@")
    ? (name.match(/^@([^:]+):/)?.[1]?.[0]?.toUpperCase() || name[1]?.toUpperCase() || "?")
    : (Array.from(name)[0]?.toUpperCase() || "?");

  const playingSoundRing = "var(--color-yellow)";
  const ringColor = playingSoundEmoji ? playingSoundRing : speaking ? 'var(--color-green)' : 'transparent';
  const outline = ringColor === 'transparent' ? 'none' : `2px solid ${ringColor}`;
  const glow = speaking && !playingSoundEmoji ? 'speaking-glow 2s ease-in-out infinite' : 'none';

  // Badge is ~60% of avatar size and overflows the bottom-right corner so the
  // emoji stays readable even at the small sidebar size (24px → 14px badge).
  const badgeDim = Math.round(dim * 0.6);
  const badgeFontSize = Math.round(badgeDim * 0.7);

  return (
    <div style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name}
          style={{
            width: dim,
            height: dim,
            borderRadius: '50%',
            objectFit: 'cover' as const,
            transition: 'background 200ms, color 200ms, outline-color 200ms',
            outline,
            outlineOffset: 1,
            animation: glow,
          }}
        />
      ) : (
        <div style={{
          width: dim,
          height: dim,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 600,
          fontSize,
          transition: 'all 200ms',
          background: speaking ? 'rgba(125, 220, 135, 0.15)' : 'var(--color-surface-container-highest)',
          color: speaking ? 'var(--color-green)' : 'var(--color-on-surface-variant)',
          outline,
          outlineOffset: 1,
          animation: glow,
        }}>
          {initial}
        </div>
      )}
      {presence && (
        <span style={{
          position: 'absolute' as const,
          bottom: -1,
          right: -1,
          width: 8,
          height: 8,
          borderRadius: '50%',
          border: '2px solid var(--color-surface-container-low)',
          background: presence === "online" ? 'var(--color-green)' : presence === "unavailable" ? 'var(--color-yellow)' : 'var(--color-outline)',
        }} />
      )}
      {playingSoundEmoji && (
        <span
          aria-hidden
          style={{
            position: 'absolute' as const,
            bottom: -Math.round(badgeDim * 0.25),
            right: -Math.round(badgeDim * 0.25),
            width: badgeDim,
            height: badgeDim,
            borderRadius: '50%',
            background: 'var(--color-surface-container-low)',
            border: '1.5px solid var(--color-yellow)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: badgeFontSize,
            lineHeight: 1,
            boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
            animation: 'sound-badge-pop 160ms cubic-bezier(0.34, 1.56, 0.64, 1)',
            pointerEvents: 'none' as const,
          }}
        >
          {playingSoundEmoji}
        </span>
      )}
    </div>
  );
}
