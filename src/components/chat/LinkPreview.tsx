import { useState, useEffect } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";

interface LinkPreviewData {
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
}

// Successful results — cached forever for the session.
const previewCache = new Map<string, LinkPreviewData>();
// Failed/empty results — cached with a short TTL so we don't hammer broken
// URLs on every re-render but still recover quickly from transient failures.
const failureCache = new Map<string, number>();
const FAILURE_TTL_MS = 10_000;
// Permanent failures (403, 404, etc.) — cached much longer, no point retrying.
const PERMANENT_FAILURE_TTL_MS = 300_000; // 5 min

// Concurrency limiter — when a channel scrolls and many messages render at
// once, dozens of fetch_link_preview calls used to fire in parallel and most
// of them failed with "error sending request" (connection/TLS exhaustion).
// 8 is a balance between speed (parallelism) and avoiding the overload that
// caused the cold-start failures.
const MAX_CONCURRENT = 8;
let activeFetches = 0;
const fetchQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeFetches < MAX_CONCURRENT) {
    activeFetches++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    fetchQueue.push(() => {
      activeFetches++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeFetches--;
  // LIFO: process the most recently queued fetch first. Messages render
  // chronologically (oldest at the top, newest at the bottom), so popping
  // the latest entry means we prioritise the messages near the user's
  // scroll position (which is usually the bottom of the chat).
  const next = fetchQueue.pop();
  if (next) next();
}

/**
 * Detect transient errors that warrant a retry (versus permanent failures
 * like HTTP 403 / 404 which we should accept). reqwest reports connection
 * issues as "error sending request"; this matches such transient errors.
 */
function isTransientError(err: unknown): boolean {
  const msg = String(err || "");
  return msg.includes("error sending request") || msg.includes("dns") || msg.includes("timeout");
}

/** HTTP 4xx/5xx errors that will never resolve on retry. */
function isPermanentHttpError(err: unknown): boolean {
  const msg = String(err || "");
  return /HTTP (403|404|405|410|451)/.test(msg);
}

async function fetchPreview(url: string): Promise<LinkPreviewData | null> {
  // Successful cache hit
  const hit = previewCache.get(url);
  if (hit) return hit;

  // Recent failure — skip the fetch
  const failAt = failureCache.get(url);
  if (failAt && Date.now() - failAt < FAILURE_TTL_MS) return null;

  await acquireSlot();
  try {
    const { invoke } = await import("@tauri-apps/api/core");

    // Try up to 2 times for transient errors (e.g. cold-start TLS failures
    // that resolve once the shared client has live keep-alive connections).
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await invoke<LinkPreviewData>("fetch_link_preview", { url });
        const hasData = data && (data.title || data.description);
        if (hasData) {
          previewCache.set(url, data);
          failureCache.delete(url);
          return data;
        }
        // No usable data — not a transient error, give up
        failureCache.set(url, Date.now());
        return null;
      } catch (err) {
        lastError = err;
        if (!isTransientError(err) || attempt === 1) break;
        // Brief backoff so the shared client can establish keep-alive
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (isPermanentHttpError(lastError)) {
      // Silent — sites like LeBonCoin, Amazon block bot requests; nothing we can do.
      failureCache.set(url, Date.now() + PERMANENT_FAILURE_TTL_MS - FAILURE_TTL_MS);
    } else {
      console.warn("[Sion][LinkPreview] fetch failed after retries", url, lastError);
      failureCache.set(url, Date.now());
    }
    return null;
  } finally {
    releaseSlot();
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
    const hit = previewCache.get(url);
    if (hit) {
      setData(hit);
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
