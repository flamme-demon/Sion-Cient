interface UserAvatarProps {
  name: string;
  speaking: boolean;
  size?: "sm" | "md";
  avatarUrl?: string;
  presence?: "online" | "offline" | "unavailable";
}

export function UserAvatar({ name, speaking, size = "sm", avatarUrl, presence }: UserAvatarProps) {
  const dim = size === "sm" ? 24 : 36;
  const fontSize = size === "sm" ? 10 : 14;

  // Extract display name: if name starts with @, extract the localpart (@user:server.com → user)
  // Otherwise use the first character of the name
  const initial = name.startsWith("@")
    ? (name.match(/^@([^:]+):/)?.[1]?.[0]?.toUpperCase() || name[1]?.toUpperCase() || "?")
    : name[0]?.toUpperCase() || "?";

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
            transition: 'background 200ms, color 200ms',
            outline: speaking ? '2px solid var(--color-green)' : 'none',
            outlineOffset: 1,
            animation: speaking ? 'speaking-glow 2s ease-in-out infinite' : 'none',
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
          outline: speaking ? '2px solid var(--color-green)' : 'none',
          outlineOffset: 1,
          animation: speaking ? 'speaking-glow 2s ease-in-out infinite' : 'none',
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
    </div>
  );
}
