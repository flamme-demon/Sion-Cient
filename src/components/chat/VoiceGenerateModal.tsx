import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  listTtsModels,
  detectTtsEngine,
  generateSpeech,
  materializeRef,
  installTtsModel,
  installTtsEngine,
  transcribeRef,
  bufferToWav,
  checkRefDuration,
  VOICE_CATEGORY,
  TTS_MODEL_LABELS,
  REF_MIN_SEC,
  REF_MAX_SEC,
  type TtsModelInfo,
} from "../../services/ttsService";
import { uploadSound, type SoundEntry } from "../../services/soundboardService";
import { AudioTrimmer } from "./AudioTrimmer";
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
  const [enginePct, setEnginePct] = useState<number | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  /** Fichier réellement affiché dans le trimmer, quelle que soit sa provenance. */
  const [refFile, setRefFile] = useState<File | null>(null);
  /** Sélection courante rapportée par <AudioTrimmer>. */
  const regionRef = useRef<{ start: number; end: number; buffer: AudioBuffer } | null>(null);
  // Miroir d'état : la ref seule ne redéclenche pas le rendu, or l'activation
  // des boutons dépend de la présence d'une sélection décodée.
  const [hasRegion, setHasRegion] = useState(false);
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

  /** Le WAV de la sélection courante — seul format accepté par --voice-ref. */
  const selectionWav = (): File => {
    const r = regionRef.current;
    if (!r) throw new Error(t("tts.refGone"));
    return bufferToWav(r.buffer, r.start, r.end);
  };

  /** Pré-remplit la transcription via le moteur ASR déjà présent. On transcrit
   *  la sélection, pas le fichier entier : c'est elle qui sert de référence. */
  const autoTranscribe = async () => {
    setError(null);
    setTranscribing(true);
    try {
      setRefText(await transcribeRef(selectionWav()));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg === "busy" ? t("tts.transcribeBusy") : msg);
    } finally {
      setTranscribing(false);
    }
  };

  const installEngine = async () => {
    setError(null);
    setEnginePct(0);
    try {
      await installTtsEngine(setEnginePct);
      setEngineOk(!!(await detectTtsEngine()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnginePct(null);
    }
  };

  const pickLocal = async (f: File) => {
    setError(null);
    setRefWarning(null);
    if (!f.type.startsWith("audio/")) {
      setError(t("tts.errorNotAudio"));
      return;
    }
    regionRef.current = null;
    setHasRegion(false);
    setLocalRef(f);
    setRefFile(f);
    setRefSoundId("");
  };

  /** Charge une voix stockée dans le trimmer. */
  const pickStored = async (eventId: string) => {
    setError(null);
    setRefWarning(null);
    setRefSoundId(eventId);
    setLocalRef(null);
    regionRef.current = null;
    setHasRegion(false);
    setRefFile(null);
    if (!eventId) return;
    const picked = voices.find((v) => v.eventId === eventId);
    if (!picked) {
      setError(t("tts.refGone"));
      return;
    }
    try {
      setRefFile(await resolveSound(picked));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Avertissement seulement : audio.cpp accepte des extraits hors plage
   *  (montages compris), c'est simplement moins fidèle. */
  const onRegion = (start: number, end: number, buffer: AudioBuffer) => {
    regionRef.current = { start, end, buffer };
    setHasRegion(true);
    const w = checkRefDuration(end - start);
    setRefWarning(w ? t(`tts.ref.${w}`, { min: REF_MIN_SEC, max: REF_MAX_SEC }) : null);
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
      const refPath = await materializeRef(selectionWav());
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

  // Une sélection décodée est le vrai prérequis : un fichier choisi mais
  // illisible ne doit pas laisser croire qu'on peut générer.
  const hasRef = hasRegion;
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
              display: "flex",
              flexDirection: "column",
              gap: 8,
              fontSize: 12,
              color: "var(--color-on-error-container)",
              background: "var(--color-error-container)",
              padding: "8px 12px",
              borderRadius: 8,
            }}
          >
            <span>{t("tts.engineMissing")}</span>
            <button
              type="button"
              onClick={installEngine}
              disabled={enginePct !== null}
              style={{ ...btn(true, enginePct !== null), alignSelf: "flex-start" }}
            >
              {enginePct !== null ? t("tts.installing", { pct: enginePct }) : t("tts.installEngine")}
            </button>
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
            <select value={refSoundId} onChange={(e) => pickStored(e.target.value)} style={inputStyle}>
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
          {/* Même trimmer que la soundboard et les sons de canal : écoute avec
              forme d'onde, et découpe l'extrait sur la fenêtre utile. */}
          {refFile && (
            <AudioTrimmer file={refFile} maxSec={REF_MAX_SEC} onChange={onRegion} />
          )}
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
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={refText}
                onChange={(e) => setRefText(e.target.value)}
                placeholder={t("tts.referenceTextPlaceholder")}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                onClick={autoTranscribe}
                disabled={!hasRef || transcribing}
                style={{ ...btn(false, !hasRef || transcribing), whiteSpace: "nowrap" }}
                title={t("tts.transcribeHint")}
              >
                {transcribing ? "…" : t("tts.transcribe")}
              </button>
            </div>
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
