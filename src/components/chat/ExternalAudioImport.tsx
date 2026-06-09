import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { probeUrlMedia, importUrlAudio, type UrlMediaInfo } from "../../services/ytdlpService";
import { detectYtdlp, installYtdlp } from "../../services/ytdlpInstall";

/** Videos longer than this (seconds) require an explicit start/end so we don't
 *  download (and decode) the whole track. Hard-coded by product decision. */
const RANGE_THRESHOLD_SEC = 5 * 60;

interface Props {
  /** Receives the downloaded audio File (+ probed title) ready for the trimmer. */
  onImported: (file: File, suggestedLabel: string) => void;
}

const inputStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 10, boxSizing: 'border-box',
  border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-container-high)',
  color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit', outline: 'none',
};

const fmt = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

/** Parse "ss", "mm:ss" or "hh:mm:ss" → seconds (NaN if empty/invalid). */
const parseTime = (v: string): number => {
  const t = v.trim();
  if (!t) return NaN;
  if (!t.includes(":")) return Number(t);
  const parts = t.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

/** Reusable "import audio from a URL" block (yt-dlp). Used by the soundboard
 *  upload modal and the voice-cue picker. Handles install prompt, probe,
 *  optional time range for long videos, and download. */
export function ExternalAudioImport({ onImported }: Props) {
  const { t } = useTranslation();
  const [ready, setReady] = useState<boolean | null>(null); // null = checking
  const [installPct, setInstallPct] = useState<number | null>(null);
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<UrlMediaInfo | null>(null);
  const [startStr, setStartStr] = useState("");
  const [endStr, setEndStr] = useState("");
  const [phase, setPhase] = useState<"idle" | "probing" | "importing">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { detectYtdlp().then((p) => setReady(!!p)).catch(() => setReady(false)); }, []);

  const install = async () => {
    setError(null);
    setInstallPct(0);
    try {
      await installYtdlp((pct) => setInstallPct(pct));
      setReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallPct(null);
    }
  };

  const analyze = async () => {
    if (!url.trim() || phase !== "idle") return;
    setError(null);
    setInfo(null);
    setPhase("probing");
    try {
      setInfo(await probeUrlMedia(url.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
    }
  };

  const needsRange = !!info && info.duration > RANGE_THRESHOLD_SEC;
  const start = parseTime(startStr);
  const end = parseTime(endStr);
  const rangeOk = !needsRange || (Number.isFinite(start) && Number.isFinite(end) && end > start);

  const download = async () => {
    if (!url.trim() || phase !== "idle" || !rangeOk) return;
    setError(null);
    setPhase("importing");
    try {
      const range = needsRange ? { start, end } : undefined;
      const file = await importUrlAudio(url.trim(), range);
      onImported(file, info?.title?.slice(0, 60) || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
    }
  };

  if (ready === null) {
    return <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>…</div>;
  }

  if (!ready) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 12, border: '1px dashed var(--color-outline-variant)', background: 'var(--color-surface-container-high)' }}>
        <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("extAudio.notInstalled")}</span>
        <button type="button" onClick={install} disabled={installPct !== null}
          style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: installPct !== null ? 'default' : 'pointer', background: 'var(--color-primary)', color: 'var(--color-on-primary)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', alignSelf: 'flex-start' }}>
          {installPct !== null ? t("extAudio.installing", { pct: installPct }) : t("extAudio.install")}
        </button>
        {error && <span style={{ fontSize: 12, color: 'var(--color-error)' }}>{error}</span>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={url} onChange={(e) => { setUrl(e.target.value); setInfo(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") analyze(); }}
          placeholder={t("extAudio.urlPlaceholder")} style={{ ...inputStyle, flex: 1 }}
        />
        <button type="button" onClick={analyze} disabled={!url.trim() || phase !== "idle"}
          style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: (!url.trim() || phase !== "idle") ? 'default' : 'pointer', background: 'var(--color-surface-container-highest)', color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit', whiteSpace: 'nowrap', opacity: (!url.trim() || phase !== "idle") ? 0.5 : 1 }}>
          {phase === "probing" ? t("extAudio.analyzing") : t("extAudio.analyze")}
        </button>
      </div>

      {info && (
        <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
          {info.title ? `${info.title} · ` : ""}{info.duration > 0 ? fmt(info.duration) : "?"}
        </div>
      )}

      {needsRange && (
        <>
          <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
            {t("extAudio.longHint", { dur: fmt(info!.duration) })}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("extAudio.start")}</span>
            <input value={startStr} onChange={(e) => setStartStr(e.target.value)} placeholder="1:30" style={{ ...inputStyle, width: 80 }} />
            <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("extAudio.end")}</span>
            <input value={endStr} onChange={(e) => setEndStr(e.target.value)} placeholder="1:55" style={{ ...inputStyle, width: 80 }} />
          </div>
        </>
      )}

      {info && (
        <button type="button" onClick={download} disabled={phase !== "idle" || !rangeOk}
          style={{ padding: '8px 16px', borderRadius: 10, border: 'none', cursor: (phase !== "idle" || !rangeOk) ? 'default' : 'pointer', background: 'var(--color-primary)', color: 'var(--color-on-primary)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', alignSelf: 'flex-start', opacity: (phase !== "idle" || !rangeOk) ? 0.5 : 1 }}>
          {phase === "importing" ? t("extAudio.downloading") : t("extAudio.download")}
        </button>
      )}

      {error && <span style={{ fontSize: 12, color: 'var(--color-error)', background: 'var(--color-error-container)', padding: '6px 10px', borderRadius: 8 }}>{error}</span>}
    </div>
  );
}
