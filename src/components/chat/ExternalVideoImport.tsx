import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { probeUrlFormats, importUrlVideo, type UrlFormatsInfo } from "../../services/ytdlpService";
import { detectYtdlp, installYtdlp } from "../../services/ytdlpInstall";
import { getMaxUploadSize } from "../../services/matrixService";

const RANGE_THRESHOLD_SEC = 5 * 60;

const fmtDur = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
const parseTime = (v: string): number => {
  const t = v.trim();
  if (!t) return NaN;
  if (!t.includes(":")) return Number(t);
  const parts = t.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};
const fmtSize = (b: number) => (b >= 1_000_000 ? `${(b / 1_048_576).toFixed(1)} Mo` : `${Math.max(1, Math.round(b / 1024))} Ko`);

const inputStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 10, boxSizing: 'border-box',
  border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-container-high)',
  color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit', outline: 'none',
};

interface Props {
  onImported: (file: File) => void;
  onClose: () => void;
}

/** Modal: import a video from an external URL (yt-dlp) into a chat message.
 *  Lists available resolutions with size + codec, gated by the server upload
 *  limit; optional time range for long videos. */
export function ExternalVideoImport({ onImported, onClose }: Props) {
  const { t } = useTranslation();
  const [ready, setReady] = useState<boolean | null>(null);
  const [installPct, setInstallPct] = useState<number | null>(null);
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<UrlFormatsInfo | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [startStr, setStartStr] = useState("");
  const [endStr, setEndStr] = useState("");
  const [phase, setPhase] = useState<"idle" | "probing" | "importing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ phase: string; pct: number } | null>(null);

  useEffect(() => { detectYtdlp().then((p) => setReady(!!p)).catch(() => setReady(false)); }, []);
  useEffect(() => { getMaxUploadSize().then(setLimit).catch(() => setLimit(null)); }, []);

  const install = async () => {
    setError(null);
    setInstallPct(0);
    try { await installYtdlp((p) => setInstallPct(p)); setReady(true); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setInstallPct(null); }
  };

  const needsRange = !!info && info.duration > RANGE_THRESHOLD_SEC;
  const start = parseTime(startStr);
  const end = parseTime(endStr);
  const rangeActive = needsRange && Number.isFinite(start) && Number.isFinite(end) && end > start;

  // Disable an option only when downloading the FULL video would exceed the
  // limit (i.e. no usable range). With a range the real size is smaller and the
  // Rust side enforces the final cap.
  const isOverLimit = (size: number) => !rangeActive && !!limit && size > limit;

  const analyze = async () => {
    if (!url.trim() || phase !== "idle") return;
    setError(null);
    setInfo(null);
    setHeight(null);
    setPhase("probing");
    try {
      const res = await probeUrlFormats(url.trim());
      setInfo(res);
      // Default: highest resolution that fits the limit (full video), else lowest.
      const fitting = res.options.filter((o) => !limit || o.size <= limit);
      const pick = (fitting.length ? fitting : res.options).slice(-1)[0] || res.options[0];
      setHeight(pick ? pick.height : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
    }
  };

  const download = async () => {
    if (!info || height == null || phase !== "idle") return;
    if (needsRange && !rangeActive) { setError(t("extVideo.rangeRequired")); return; }
    setError(null);
    setPhase("importing");
    setProgress(null);
    try {
      const opt = info.options.find((o) => o.height === height);
      const file = await importUrlVideo(url.trim(), {
        height,
        start: rangeActive ? start : undefined,
        end: rangeActive ? end : undefined,
        maxBytes: limit || undefined,
        // Non-VP9 sources (H.264 etc.) → re-encode to WebM on the sender so
        // recipients don't each have to transcode.
        recodeWebm: !!opt && opt.codec !== "VP9",
        title: info.title,
        durationSec: info.duration,
      }, (p) => setProgress(p));
      onImported(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
      setProgress(null);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--color-surface-container-high)', borderRadius: 16, padding: 20, width: 460, maxWidth: '92vw', display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-on-surface)' }}>{t("extVideo.title")}</div>

        {ready === false ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("extAudio.notInstalled")}</span>
            <button type="button" onClick={install} disabled={installPct !== null}
              style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: installPct !== null ? 'default' : 'pointer', background: 'var(--color-primary)', color: 'var(--color-on-primary)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', alignSelf: 'flex-start' }}>
              {installPct !== null ? t("extAudio.installing", { pct: installPct }) : t("extAudio.install")}
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={url} onChange={(e) => { setUrl(e.target.value); setInfo(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") analyze(); }}
                placeholder={t("extAudio.urlPlaceholder")} style={{ ...inputStyle, flex: 1 }} />
              <button type="button" onClick={analyze} disabled={!url.trim() || phase !== "idle"}
                style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: (!url.trim() || phase !== "idle") ? 'default' : 'pointer', background: 'var(--color-surface-container-highest)', color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit', whiteSpace: 'nowrap', opacity: (!url.trim() || phase !== "idle") ? 0.5 : 1 }}>
                {phase === "probing" ? t("extAudio.analyzing") : t("extAudio.analyze")}
              </button>
            </div>

            {info && (
              <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
                {info.title ? `${info.title} · ` : ""}{info.duration > 0 ? fmtDur(info.duration) : "?"}
              </div>
            )}

            {needsRange && (
              <>
                <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>{t("extAudio.longHint", { dur: fmtDur(info!.duration) })}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("extAudio.start")}</span>
                  <input value={startStr} onChange={(e) => setStartStr(e.target.value)} placeholder="1:30" style={{ ...inputStyle, width: 80 }} />
                  <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("extAudio.end")}</span>
                  <input value={endStr} onChange={(e) => setEndStr(e.target.value)} placeholder="1:55" style={{ ...inputStyle, width: 80 }} />
                </div>
              </>
            )}

            {info && info.options.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {info.options.map((o) => {
                  const over = isOverLimit(o.size);
                  const selected = height === o.height;
                  return (
                    <label key={`${o.height}-${o.codec}`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10,
                        cursor: over ? 'not-allowed' : 'pointer', opacity: over ? 0.45 : 1,
                        border: `1px solid ${selected ? 'var(--color-primary)' : 'var(--color-outline-variant)'}`,
                        background: selected ? 'var(--color-primary-container)' : 'transparent',
                      }}>
                      <input type="radio" name="vidres" disabled={over} checked={selected}
                        onChange={() => setHeight(o.height)} style={{ accentColor: 'var(--color-primary)' }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface)', minWidth: 52 }}>{o.height > 0 ? `${o.height}p` : t("extVideo.original")}</span>
                      <span style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>{o.codec !== "?" ? `${o.codec} · ` : ""}{o.codec === "VP9" ? t("extVideo.native") : t("extVideo.recoded")}</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ fontSize: 12, color: over ? 'var(--color-error)' : 'var(--color-on-surface-variant)' }}>
                        {o.size > 0 ? `~${fmtSize(o.size)}` : t("extVideo.sizeUnknown")}{over ? ` · ${t("extVideo.overLimit")}` : ""}
                      </span>
                    </label>
                  );
                })}
                {limit != null && (
                  <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>{t("extVideo.serverLimit", { size: fmtSize(limit) })}</span>
                )}
              </div>
            )}

            {error && <span style={{ fontSize: 12, color: 'var(--color-error)', background: 'var(--color-error-container)', padding: '6px 10px', borderRadius: 8 }}>{error}</span>}

            {phase === "importing" && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--color-on-surface)' }}>
                  <span>{progress?.phase === "convert" ? t("extVideo.phaseConvert") : t("extVideo.phaseDownload")}</span>
                  <span style={{ color: 'var(--color-on-surface-variant)', fontVariantNumeric: 'tabular-nums' }}>
                    {progress ? `${Math.round(progress.pct)}%` : "…"}
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 999, background: 'var(--color-surface-container-highest)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${progress ? Math.round(progress.pct) : 0}%`,
                    background: 'var(--color-primary)', borderRadius: 999, transition: 'width 200ms',
                  }} />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={onClose}
                style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', background: 'var(--color-surface-container-highest)', color: 'var(--color-on-surface)' }}>
                {t("poll.cancel")}
              </button>
              <button type="button" onClick={download} disabled={!info || height == null || phase !== "idle"}
                style={{ padding: '8px 16px', borderRadius: 10, border: 'none', cursor: (!info || height == null || phase !== "idle") ? 'default' : 'pointer', background: 'var(--color-primary)', color: 'var(--color-on-primary)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', opacity: (!info || height == null || phase !== "idle") ? 0.5 : 1 }}>
                {phase === "importing" ? t("extVideo.downloading") : t("extVideo.download")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
