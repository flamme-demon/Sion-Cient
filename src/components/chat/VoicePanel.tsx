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
  GENERATED_CATEGORY,
  TTS_MODEL_LABELS,
  REF_MIN_SEC,
  REF_MAX_SEC,
  type TtsModelInfo,
} from "../../services/ttsService";
import { uploadSound, playSoundLocal, broadcastSound, type SoundEntry } from "../../services/soundboardService";
import { uploadFile } from "../../services/matrixService";
import { resolveAvatar } from "../../services/ttsService";
import { AudioPreview } from "./AudioPreview";
import { ImageCropper } from "./ImageCropper";
import { useSettingsStore } from "../../stores/useSettingsStore";

const MAX_TEXT = 500;

interface Props {
  /** Sons de la soundboard : ceux de la catégorie Voix servent de références. */
  sounds: SoundEntry[];
  /** Résout un son Matrix en File (téléchargement + cache côté service). */
  resolveSound: (s: SoundEntry) => Promise<File>;
  /** Appelé après ajout du résultat à la soundboard. */
  onUploaded: () => void;
  /** Diffusion possible seulement si l'on est connecté à un salon vocal. */
  connectedVoice: boolean;
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

export function VoicePanel({ sounds, resolveSound, onUploaded, connectedVoice }: Props) {
  const { t } = useTranslation();
  const ttsModel = useSettingsStore((s) => s.ttsModel);
  const setTtsModel = useSettingsStore((s) => s.setTtsModel);

  const [models, setModels] = useState<TtsModelInfo[]>([]);
  const [engineOk, setEngineOk] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [refText, setRefText] = useState("");
  const [localRef, setLocalRef] = useState<File | null>(null);
  const [refWarning, setRefWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installPct, setInstallPct] = useState<number | null>(null);
  const [enginePct, setEnginePct] = useState<number | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  /** Fichier réellement affiché dans le trimmer, quelle que soit sa provenance. */
  const [refFile, setRefFile] = useState<File | null>(null);
  /** Buffer décodé de la référence, remonté par <AudioPreview>. */
  const refBufferRef = useRef<AudioBuffer | null>(null);
  // Miroir d'état : la ref seule ne redéclenche pas le rendu, or l'activation
  // des boutons dépend de la présence d'un extrait décodé.
  const [refReady, setRefReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<File | null>(null);
  /** "list" = galerie des voix, "generate" = formulaire pour la voix choisie. */
  const [view, setView] = useState<"list" | "generate">("list");
  /** Voix de la galerie en cours d'utilisation (null si extrait local). */
  const [activeVoice, setActiveVoice] = useState<SoundEntry | null>(null);
  const [saveName, setSaveName] = useState("");
  const [saveEmoji, setSaveEmoji] = useState("🗣️");
  /** Portrait choisi pour la voix qu'on s'apprête à enregistrer. */
  const [savePortrait, setSavePortrait] = useState<File | null>(null);
  /** Image brute en attente de recadrage. */
  const [cropSource, setCropSource] = useState<File | null>(null);
  const portraitInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Les voix sont des sons marqués `kind: "voice"` — pas de stockage séparé, la
  // room soundboard les partage déjà entre tous les membres.
  const voices = useMemo(() => sounds.filter((s) => s.kind === "voice"), [sounds]);

  const current = models.find((m) => m.id === ttsModel) || null;

  /** Portraits résolus en URL affichables, indexés par son. */
  const [portraits, setPortraits] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const wanted = voices.filter((v) => v.avatarUrl);
    if (wanted.length === 0) return;
    Promise.all(
      wanted.map(async (v) => [v.eventId, await resolveAvatar(v.avatarUrl!)] as const),
    )
      .then((pairs) => {
        if (!alive) return;
        setPortraits(Object.fromEntries(pairs.filter(([, url]) => url) as [string, string][]));
      })
      .catch(() => { /* portrait absent : l'emoji prend le relais */ });
    return () => { alive = false; };
  }, [voices]);

  useEffect(() => {
    listTtsModels().then(setModels).catch(() => setModels([]));
    detectTtsEngine()
      .then((p) => setEngineOk(!!p))
      .catch(() => setEngineOk(false));
  }, []);

  /** L'extrait en WAV — seul format accepté par --voice-ref. */
  const selectionWav = (): File => {
    const b = refBufferRef.current;
    if (!b) throw new Error(t("tts.refGone"));
    return bufferToWav(b);
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
    refBufferRef.current = null;
    setRefReady(false);
    setLocalRef(f);
    setRefFile(f);
    if (!saveName) setSaveName(f.name.replace(/\.[^.]+$/, "").slice(0, 40));
  };

  /** Ouvre la génération avec cette voix déjà chargée en référence. */
  const openVoice = async (v: SoundEntry) => {
    setError(null);
    setRefWarning(null);
    setActiveVoice(v);
    setLocalRef(null);
    refBufferRef.current = null;
    setRefReady(false);
    setRefFile(null);
    setResult(null);
    // La transcription voyage avec la voix : les modèles qui l'exigent la
    // retrouvent sans que l'utilisateur la ressaisisse à chaque usage.
    setRefText(v.refText || "");
    setView("generate");
    try {
      setRefFile(await resolveSound(v));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Génération depuis un extrait local, hors galerie. */
  const openLocal = () => {
    setError(null);
    setRefWarning(null);
    setActiveVoice(null);
    setLocalRef(null);
    refBufferRef.current = null;
    setRefReady(false);
    setRefFile(null);
    setResult(null);
    setRefText("");
    setView("generate");
  };

  /**
   * Publie l'extrait local comme voix de référence réutilisable.
   *
   * On enregistre le WAV décodé plutôt que le fichier d'origine : c'est ce que
   * le moteur consommera de toute façon, et ça évite qu'un format exotique
   * bloque un futur clonage.
   */
  const saveAsVoice = async () => {
    if (busy || !saveName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const avatar = savePortrait ? await uploadFile(savePortrait) : undefined;
      await uploadSound(
        selectionWav(),
        saveName.trim(),
        VOICE_CATEGORY,
        saveEmoji || "🗣️",
        1.0,
        { refText: refText.trim() || undefined, avatar },
      );
      onUploaded();
      setSaveName("");
      setSavePortrait(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const backToList = () => {
    setView("list");
    setResult(null);
  };

  /** Avertissement seulement : audio.cpp accepte des extraits hors plage
   *  (montages compris), c'est simplement moins fidèle. */
  const onRefDecoded = (buffer: AudioBuffer) => {
    refBufferRef.current = buffer;
    setRefReady(true);
    const w = checkRefDuration(buffer.duration);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Publie le résultat dans la soundboard, et le diffuse si demandé.
   *
   * La diffusion passe forcément par l'upload : `broadcastSound` transmet une
   * URL mxc que chaque pair va chercher lui-même — on ne pousse pas les octets
   * dans le canal de données.
   */
  const publish = async (alsoPlay: boolean) => {
    if (!result || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { mxcUrl, duration } = await uploadSound(
        result,
        text.trim().slice(0, 60),
        GENERATED_CATEGORY,
        "🗣️",
      );
      onUploaded();
      if (alsoPlay) {
        await playSoundLocal(mxcUrl);
        broadcastSound(mxcUrl, "🗣️", duration);
      }
      setResult(null);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Une sélection décodée est le vrai prérequis : un fichier choisi mais
  // illisible ne doit pas laisser croire qu'on peut générer.
  const hasRef = refReady;
  const refTextOk = !current?.needsReferenceText || refText.trim().length > 0;
  const canGenerate =
    !!current && current.installed && engineOk === true && hasRef && !!text.trim() && refTextOk && !busy;

  if (view === "list") {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        <div style={{ fontSize: 12, color: "var(--color-on-surface-variant)", marginBottom: 12, lineHeight: 1.5 }}>
          {t("tts.listHint")}
        </div>
        {voices.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--color-outline)", marginBottom: 12, lineHeight: 1.5 }}>
            {t("tts.listEmpty")}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
          {voices.map((v) => (
            <div
              key={v.eventId}
              onClick={() => openVoice(v)}
              title={v.label}
              style={{
                position: "relative", display: "flex", flexDirection: "column", gap: 8,
                padding: 12, borderRadius: 14,
                border: "1px solid var(--color-outline-variant)",
                background: "var(--color-surface-container)",
                cursor: "pointer", transition: "background 120ms, border-color 120ms",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-surface-container-high)"; e.currentTarget.style.borderColor = "var(--color-primary)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-surface-container)"; e.currentTarget.style.borderColor = "var(--color-outline-variant)"; }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                <div style={{ width: 44, height: 44, borderRadius: 999, background: "var(--color-surface-container-highest)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, overflow: "hidden", flexShrink: 0 }}>
                  {portraits[v.eventId]
                    ? <img src={portraits[v.eventId]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : (v.emoji || "🗣️")}
                </div>
                {/* Marqueur explicite : ces voix servent à SYNTHÉTISER de la
                    parole, pas à rejouer un son. */}
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, padding: "2px 6px", borderRadius: 999, background: "var(--color-primary)", color: "var(--color-on-primary)" }}>
                  {t("tts.badge")}
                </span>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-on-surface)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {v.label}
                </div>
                <div style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>
                  {t("tts.cardAction")}
                </div>
              </div>
            </div>
          ))}

          {/* Extrait local : même place que les voix, sans passer par Matrix. */}
          <div
            onClick={openLocal}
            style={{
              display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 14,
              border: "1px dashed var(--color-outline-variant)", background: "transparent", cursor: "pointer",
            }}
          >
            <div style={{ width: 44, height: 44, borderRadius: 999, background: "var(--color-surface-container-high)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: "var(--color-on-surface-variant)" }}>+</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-on-surface)" }}>{t("tts.useLocal")}</div>
            <div style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>{t("tts.useLocalHint")}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
      {cropSource && (
        <ImageCropper
          file={cropSource}
          onCancel={() => setCropSource(null)}
          onCropped={(f) => { setSavePortrait(f); setCropSource(null); }}
        />
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 560, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <button type="button" onClick={backToList} style={{ ...btn(false, false), padding: "6px 12px" }}>
            ← {t("tts.back")}
          </button>
          <span style={{
            fontSize: 14, fontWeight: 600, color: "var(--color-on-surface)",
            minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {activeVoice ? `${activeVoice.emoji || "🗣️"} ${activeVoice.label}` : t("tts.useLocal")}
          </span>
        </div>
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
          {/* Le choix de la voix se fait dans la galerie ; ici on ne propose que
              de remplacer l'extrait par un fichier local. */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
              <span
                title={localRef.name}
                style={{
                  fontSize: 12, color: "var(--color-on-surface-variant)",
                  flex: "1 1 0", minWidth: 0,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
              >
                {localRef.name}
              </span>
            )}
          </div>
          {refFile && <AudioPreview file={refFile} onDecoded={onRefDecoded} />}
          {refWarning && (
            <span style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>{refWarning}</span>
          )}

          {/* Un extrait local n'existe que dans cette session : sans ça, la
              galerie reste vide et personne d'autre ne peut s'en servir. */}
          {localRef && refReady && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 2, flexWrap: "wrap" }}>
              <input
                ref={portraitInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) setCropSource(f); }}
              />
              {/* Portrait : remplace l'emoji dans la galerie quand il est fourni. */}
              <button
                type="button"
                onClick={() => portraitInputRef.current?.click()}
                title={t("tts.savePortrait")}
                style={{
                  width: 40, height: 40, flexShrink: 0, borderRadius: 999, border: "1px solid var(--color-outline-variant)",
                  background: "var(--color-surface-container-high)", cursor: "pointer", padding: 0, overflow: "hidden",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
                }}
              >
                {savePortrait
                  ? <img src={URL.createObjectURL(savePortrait)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : "🖼"}
              </button>
              <input
                value={saveEmoji}
                onChange={(e) => setSaveEmoji(Array.from(e.target.value).slice(-1).join(""))}
                style={{ ...inputStyle, width: 46, textAlign: "center", padding: "8px 4px" }}
                title={t("tts.saveEmoji")}
              />
              <input
                value={saveName}
                onChange={(e) => setSaveName(e.target.value.slice(0, 40))}
                placeholder={t("tts.saveNamePlaceholder")}
                style={{ ...inputStyle, flex: "1 1 120px", minWidth: 0 }}
              />
              <button
                type="button"
                onClick={saveAsVoice}
                disabled={busy || !saveName.trim()}
                style={{ ...btn(false, busy || !saveName.trim()), whiteSpace: "nowrap" }}
              >
                {t("tts.saveVoice")}
              </button>
            </div>
          )}
        </div>

        {/* Transcription — seulement pour les familles qui l'exigent */}
        {current?.needsReferenceText && (
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>
              {t("tts.referenceText")}
            </span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input
                value={refText}
                onChange={(e) => setRefText(e.target.value)}
                placeholder={t("tts.referenceTextPlaceholder")}
                style={{ ...inputStyle, flex: "1 1 140px", minWidth: 0 }}
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

        {result && <AudioPreview file={result} />}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={generate} disabled={!canGenerate} style={btn(!result, !canGenerate)}>
            {busy && !result ? t("tts.generating") : t("tts.generate")}
          </button>
          {result && (
            <>
              <button type="button" onClick={() => publish(false)} disabled={busy} style={btn(false, busy)}>
                {t("tts.addToSoundboard")}
              </button>
              <button
                type="button"
                onClick={() => publish(true)}
                disabled={busy || !connectedVoice}
                style={btn(true, busy || !connectedVoice)}
                title={connectedVoice ? undefined : t("tts.playNeedsVoice")}
              >
                {t("tts.playForAll")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
