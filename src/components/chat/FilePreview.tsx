import { CloseIcon, FileIcon } from "../icons";
import { useAppStore } from "../../stores/useAppStore";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePreview() {
  const pendingFiles = useAppStore((s) => s.pendingFiles);
  const removePendingFile = useAppStore((s) => s.removePendingFile);

  if (pendingFiles.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const, padding: '12px 12px 4px 12px' }}>
      {pendingFiles.map((pf) => (
        <div key={pf.id} style={{
          position: 'relative' as const,
          background: 'var(--color-surface-container)',
          borderRadius: 16,
          padding: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          {pf.previewUrl ? (
            <img src={pf.previewUrl} alt={pf.name} style={{ width: 48, height: 48, borderRadius: 12, objectFit: 'cover' as const }} />
          ) : (
            <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--color-surface-container-highest)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <FileIcon />
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column' as const, maxWidth: 120 }}>
            <span style={{ fontSize: 11, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{pf.name}</span>
            <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>{formatFileSize(pf.size)}</span>
          </div>
          <button
            type="button"
            onClick={() => removePendingFile(pf.id)}
            style={{
              position: 'absolute' as const,
              top: -4,
              right: -4,
              background: 'var(--color-surface-container-highest)',
              border: 'none',
              borderRadius: '50%',
              padding: 2,
              cursor: 'pointer',
              display: 'flex',
              color: 'var(--color-on-surface-variant)',
            }}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
