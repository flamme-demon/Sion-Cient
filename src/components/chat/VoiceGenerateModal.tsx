import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  listTtsModels,
  detectTtsEngine,
  generateSpeech,
  materializeRef,
  installTtsModel,
  checkRefDuration,
  VOICE_CATEGORY,
  TTS_MODEL_LABELS,
  REF_MIN_SEC,
  REF_MAX_SEC,
  type TtsModelInfo,
} from "../../services/ttsService";
import { uploadSound, type SoundEntry } from "../../services/soundboardService";
import { useSettingsStore } from "../../stores/useSettingsStore";

const MAX_TEXT = 500;

interface Props {
  /** Sons de la soundboard : ceux de la catégorie Voix servent de références. */
  sounds: SoundEntry[];
  /** Résout un son Matrix en File (téléchargement + cache côté service). */
  resolveSound: (s: SoundEntry) => Promise<File>;
  onClose: () => void;
  /** Appelé après ajout du résultat à la soundboard. */
  onUploaded: () => void;
}

const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  boxSizing: "border-box",
  border: "1px solid var(--color-outline-variant)",
  background: "var(--color-surface-container-high)",
  color: "var(--color-on-surface)",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
};

const btn = (primary: boolean, disabled: boolean): React.CSSProperties => ({
  padding: "8px 16px",
  borderRadius: 10,
  border: "none",
  cursor: disabled ? "default" : "pointer",
  background: primary ? "var(--color-primary)" : "var(--color-surface-container-highest)",
  color: primary ? "var(--color-on-primary)" : "var(--color-on-surface)",
  fontSize: 13,
  fontWeight: primary ? 600 : 400,
  fontFamily: "inherit",
  opacity: disabled ? 0.5 : 1,
});

export function VoiceGenerateModal({ sounds, resolveSound, onClose, onUploaded }: Props) {
  const { t } = useTranslation();
  const ttsModel = useSettingsStore((s) => s.ttsModel);
  const setTtsModel = useSettingsStore((s) => s.setTtsModel);

  const [models, setModels] = useState<TtsModelInfo[]>([]);
  const [engineOk, setEngineOk] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [refText, setRefText] = useState("");
  const [refSoundId, setRefSoundId] = useState<string>("");
  const [localRef, setLocalRef] = useState<File | null>(null);
  const [refWarning, setRefWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installPct, setInstallPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Les voix sont les sons rangés dans la catégorie dédiée — pas de stockage
  // séparé, la soundboard les partage déjà entre tous les membres.
  const voices = useMemo(
    () => sounds.filter((s) => s.category === VOICE_CATEGORY),
    [sounds],
  );

  const current = models.find((m) => m.id === ttsModel) || null;

  useEffect(() => {
    listTtsModels().then(setModels).catch(() => setModels([]));
    detectTtsEngine()
      .then((p) => setEngineOk(!!p))
      .catch(() => setEngineOk(false));
  }, []);

  // Révoque l'URL de prévisualisation au démontage : la garder vivante retient
  // le File en mémoire jusqu'au GC.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const pickLocal = async (f: File) => {
    setError(null);
    setRefWarning(null);
    if (!f.type.startsWith("audio/")) {
      setError(t("tts.errorNotAudio"));
      return;
    }
    setLocalRef(f);
    setRefSoundId("");
    // Avertissement seulement : audio.cpp accepte des extraits hors plage
    // (montages compris), c'est simplement moins fidèle.
    try {
      const url = URL.createObjectURL(f);
      const probe = new Audio();
      probe.preload = "metadata";
      probe.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        const w = checkRefDuration(probe.duration);
        setRefWarning(w ? t(`tts.ref.${w}`, { min: REF_MIN_SEC, max: REF_MAX_SEC }) : null);
      };
      probe.onerror = () => URL.revokeObjectURL(url);
      probe.src = url;
    } catch {
      /* la sonde de durée est un confort, pas un prérequis */
    }
  };

  const install = async () => {
    if (!current || current.installed) return;
    setError(null);
    setInstallPct(0);
    try {
      await installTtsModel(current.id, setInstallPct);
      setModels(await listTtsModels());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallPct(null);
    }
  };

  const generate = async () => {
    if (!current || busy) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      // La voix stockée peut avoir été supprimée par un autre membre entre la
      // sélection et la génération — on le signale plutôt que de planter.
      let refFile = localRef;
      if (!refFile) {
        const picked = voices.find((v) => v.eventId === refSoundId);
        if (!picked) throw new Error(t("tts.refGone"));
        refFile = await resolveSound(picked);
      }
      const refPath = await materializeRef(refFile);
      const wav = await generateSpeech(
        current.id,
        text.trim(),
        refPath,
        current.needsReferenceText ? refText.trim() : undefined,
      );
      setResult(wav);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(wav));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addToSoundboard = async () => {
    if (!result || busy) return;
    setBusy(true);
    setError(null);
    try {
      await uploadSound(result, text.trim().slice(0, 60), VOICE_CATEGORY, "🗣️");
      onUploaded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hasRef = !!localRef || !!refSoundId;
  const refTextOk = !current?.needsReferenceText || refText.trim().length > 0;
  const canGenerate =
    !!current && current.installed && engineOk === true && hasRef && !!text.trim() && refTextOk && !busy;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "92vw",
          maxHeight: "88vh",
          overflowY: "auto",
          background: "var(--color-surface-container)",
          borderRadius: 16,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, color: "var(--color-on-surface)" }}>
          {t("tts.title")}
        </h3>

        {engineOk === false && (
          <div
            style={{
              fontSize: 12,
              color: "var(--color-on-error-container)",
              background: "var(--color-error-container)",
              padding: "8px 12px",
              borderRadius: 8,
            }}
          >
            {t("tts.engineMissing")}
          </div>
        )}

        {/* Modèle */}
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>
            {t("tts.model")}
          </span>
          <select
            value={ttsModel}
            onChange={(e) => setTtsModel(e.target.value)}
            style={{ ...inputStyle }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {TTS_MODEL_LABELS[m.id] || m.id} — {(m.sizeMb / 1000).toFixed(1)} Go
                {m.installed ? "" : ` (${t("tts.notInstalled")})`}
              </option>
            ))}
          </select>
        </label>

        {current && !current.installed && (
          <button type="button" onClick={install} disabled={installPct !== null} style={btn(true, installPct !== null)}>
            {installPct !== null
              ? t("tts.installing", { pct: installPct })
              : t("tts.install", { size: (current.sizeMb / 1000).toFixed(1) })}
          </button>
        )}

        {/* Référence */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>
            {t("tts.reference")}
          </span>
          {voices.length > 0 && (
            <select
              value={refSoundId}
              onChange={(e) => {
                setRefSoundId(e.target.value);
                setLocalRef(null);
                setRefWarning(null);
              }}
              style={inputStyle}
            >
              <option value="">{t("tts.pickStored")}</option>
              {voices.map((v) => (
                <option key={v.eventId} value={v.eventId}>
                  {v.emoji ? `${v.emoji} ` : ""}
                  {v.label}
                </option>
              ))}
            </select>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickLocal(f);
              }}
            />
            <button type="button" onClick={() => fileInputRef.current?.click()} style={btn(false, false)}>
              {t("tts.pickFile")}
            </button>
            {localRef && (
              <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>
                {localRef.name}
              </span>
            )}
          </div>
          {refWarning && (
            <span style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>{refWarning}</span>
          )}
        </div>

        {/* Transcription — seulement pour les familles qui l'exigent */}
        {current?.needsReferenceText && (
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>
              {t("tts.referenceText")}
            </span>
            <input
              value={refText}
              onChange={(e) => setRefText(e.target.value)}
              placeholder={t("tts.referenceTextPlaceholder")}
              style={inputStyle}
            />
            <span style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>
              {t("tts.referenceTextHint")}
            </span>
          </label>
        )}

        {/* Texte */}
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>
            {t("tts.text")} ({text.length}/{MAX_TEXT})
          </span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT))}
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </label>

        {error && (
          <span
            style={{
              fontSize: 12,
              color: "var(--color-error)",
              background: "var(--color-error-container)",
              padding: "6px 10px",
              borderRadius: 8,
            }}
          >
            {error}
          </span>
        )}

        {previewUrl && <audio controls src={previewUrl} style={{ width: "100%" }} />}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(false, false)}>
            {t("auth.cancel")}
          </button>
          <button type="button" onClick={generate} disabled={!canGenerate} style={btn(!result, !canGenerate)}>
            {busy && !result ? t("tts.generating") : t("tts.generate")}
          </button>
          {result && (
            <button type="button" onClick={addToSoundboard} disabled={busy} style={btn(true, busy)}>
              {t("tts.addToSoundboard")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
