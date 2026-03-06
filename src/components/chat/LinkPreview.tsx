import { useState, useEffect } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";

interface LinkPreviewData {
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
}

const previewCache = new Map<string, LinkPreviewData | null>();

async function fetchPreview(url: string): Promise<LinkPreviewData | null> {
  if (previewCache.has(url)) return previewCache.get(url)!;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const data = await invoke<LinkPreviewData>("fetch_link_preview", { url });
    const hasData = data && (data.title || data.description);
    if (hasData) {
      previewCache.set(url, data);
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

export function LinkPreview({ url }: { url: string }) {
  const linkPreviews = useSettingsStore((s) => s.linkPreviews);
  const [data, setData] = useState<LinkPreviewData | null>(
    previewCache.get(url) ?? null,
  );
  const [loaded, setLoaded] = useState(previewCache.has(url));

  useEffect(() => {
    if (!linkPreviews) return;
    if (previewCache.has(url)) {
      setData(previewCache.get(url)!);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    fetchPreview(url).then((result) => {
      if (!cancelled) {
        setData(result);
        setLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [url, linkPreviews]);

  if (!linkPreviews || !loaded || !data) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        maxWidth: 400,
        background: "var(--color-surface-container-high)",
        border: "1px solid var(--color-outline-variant)",
        borderRadius: 12,
        padding: 10,
        marginTop: 6,
        textDecoration: "none",
        overflow: "hidden",
        cursor: "pointer",
        transition: "background 150ms",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-surface-container)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-surface-container-high)"; }}
    >
      {data.image && (
        <img
          src={data.image}
          alt=""
          style={{
            width: 80,
            height: 80,
            objectFit: "cover",
            borderRadius: 8,
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        {data.title && (
          <div style={{
            fontWeight: 600,
            fontSize: 13,
            color: "var(--color-on-surface)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {data.title}
          </div>
        )}
        {data.description && (
          <div style={{
            fontSize: 11,
            color: "var(--color-on-surface-variant)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            lineHeight: 1.4,
          }}>
            {data.description}
          </div>
        )}
        {data.site_name && (
          <div style={{
            fontSize: 10,
            color: "var(--color-outline)",
            marginTop: 2,
          }}>
            {data.site_name}
          </div>
        )}
      </div>
    </a>
  );
}
