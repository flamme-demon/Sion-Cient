// Memeboard : la grille des memes du salon, et leur import.
//
// Un clic fait surgir le meme par-dessus l'écran de tout le salon vocal — jeux
// compris — dans une fenêtre native (`meme_pop.rs`). Le panneau ne montre que
// des aperçus : des WebP animés, que la vue web anime sans GStreamer, là où
// une balise vidéo échouerait selon la machine.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useDockZone } from "../layout/dockZoneContext";
import {
  canSendMessage,
  findSoundboardRoom,
  getMatrixClient,
  getMemberPowerLevel,
  mxcToHttp,
} from "../../services/matrixService";
import {
  analyserMeme,
  declencherMeme,
  delaiRestantMs,
  deposerSource,
  envoyerMeme,
  listMemes,
  MEME_DUREE_MAX_MS,
  preparerMeme,
  supprimerMeme,
  type MemeAnalyse,
  type MemeEntry,
  type MemePrepare,
} from "../../services/memeboardService";
import { MemeTrimmer } from "./MemeTrimmer";
import { EmojiGridPanel } from "./EmojiGridPanel";
import { definirLecteurActif, libererLecteurActif } from "../../services/lecteurActif";

/** Identifiant de l'essai dans le registre du lecteur unique : une vidéo du
 *  fil en cours de lecture rend la main, comme quand on en lance une autre. */
const ESSAI = "meme-essai";

const ExternalVideoImport = lazy(() =>
  import("./ExternalVideoImport").then((m) => ({ default: m.ExternalVideoImport })),
);

/** Hauteur du sélecteur d'emoji, et marge qui le sépare du bouton — les
 *  mêmes que dans l'envoi d'un son. */
const EMOJI_PANNEAU_H = 300;
const EMOJI_PANNEAU_L = 320;
const EMOJI_ECART = 8;

/** Supprimer un meme d'un autre : réservé aux modérateurs, comme ailleurs. */
const NIVEAU_MODERATION = 50;

export function MemeboardPanel() {
  const { t } = useTranslation();
  const [memes, setMemes] = useState<MemeEntry[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [recherche, setRecherche] = useState("");
  const [import_, setImport] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const actif = useSettingsStore((s) => s.memeboardEnabled);
  const setActif = useSettingsStore((s) => s.setMemeboardEnabled);
  const volume = useSettingsStore((s) => s.memeboardVolume);
  const setVolume = useSettingsStore((s) => s.setMemeboardVolume);
  const compact = useDockZone() === "bottom";
  const rafraichirRef = useRef<() => void>(() => {});

  const annoncer = useCallback((texte: string) => {
    setMessage(texte);
    window.setTimeout(() => setMessage((m) => (m === texte ? null : m)), 4000);
  }, []);

  // Même rafraîchissement que la soundboard : sur le salon, et regroupé, sans
  // quoi un salon actif relancerait la pagination à chaque message.
  useEffect(() => {
    let annule = false;
    let minuterie: ReturnType<typeof setTimeout> | null = null;
    let salon: string | null = null;
    const rafraichir = async () => {
      salon = await findSoundboardRoom();
      if (annule) return;
      setRoomId(salon);
      const liste = await listMemes();
      if (!annule) setMemes(liste);
    };
    rafraichirRef.current = () => { void rafraichir(); };
    void rafraichir();
    const client = getMatrixClient();
    if (!client) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const surEvenement = (ev: any, room: any) => {
      const id = room?.roomId ?? ev?.getRoomId?.();
      if (!salon || id !== salon) return;
      if (minuterie) clearTimeout(minuterie);
      minuterie = setTimeout(() => { void rafraichir(); }, 200);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cl = client as any;
    cl.on("Room.timeline", surEvenement);
    cl.on("Room.redaction", surEvenement);
    return () => {
      annule = true;
      if (minuterie) clearTimeout(minuterie);
      cl.off("Room.timeline", surEvenement);
      cl.off("Room.redaction", surEvenement);
    };
  }, []);

  // Salon pas encore connu au montage (sync en cours) : on retente.
  useEffect(() => {
    if (roomId) return;
    const id = setInterval(() => rafraichirRef.current(), 2000);
    return () => clearInterval(id);
  }, [roomId]);

  const client = getMatrixClient();
  const moi = client?.getUserId() || "";
  const peutEnvoyer = roomId ? canSendMessage(roomId) : false;
  const peutModerer = roomId && moi ? getMemberPowerLevel(roomId, moi) >= NIVEAU_MODERATION : false;

  const visibles = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return q ? memes.filter((m) => m.label.toLowerCase().includes(q)) : memes;
  }, [memes, recherche]);

  const lancer = async (meme: MemeEntry) => {
    if (!actif) return;
    try {
      if (!(await declencherMeme(meme))) {
        annoncer(t("memeboard.tooSoon", { s: Math.ceil(delaiRestantMs() / 1000) }));
      }
    } catch (err) {
      console.warn("[Sion][meme] lecture impossible", err);
      annoncer(t("memeboard.playError"));
    }
  };

  const supprimer = async (meme: MemeEntry) => {
    if (!window.confirm(t("memeboard.deleteConfirm", { label: meme.label }))) return;
    try {
      await supprimerMeme(meme.eventId);
      rafraichirRef.current();
    } catch (err) {
      console.error("[Sion][meme] suppression impossible", err);
      annoncer(t("memeboard.deleteError"));
    }
  };

  const bascule = (
    <button
      type="button"
      onClick={() => setActif(!actif)}
      title={actif ? t("memeboard.disable") : t("memeboard.enable")}
      style={{
        flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer', padding: 4,
        borderRadius: 8, display: 'flex', color: actif ? 'var(--color-on-surface)' : 'var(--color-error)',
      }}
    >
      <svg width={compact ? 15 : 18} height={compact ? 15 : 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="3" />
        {actif
          ? <polygon points="10 9 15 12 10 15 10 9" fill="currentColor" />
          : <line x1="4" y1="4" x2="20" y2="20" />}
      </svg>
    </button>
  );

  const reglageVolume = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: compact ? '0 0 auto' : 1, color: 'var(--color-on-surface-variant)' }}>
      {bascule}
      <input
        type="range" min={0} max={1} step={0.05} value={volume}
        className="sion-range"
        disabled={!actif}
        onChange={(e) => setVolume(parseFloat(e.target.value))}
        title={t("memeboard.volume")}
        style={{
          width: compact ? 90 : undefined, flex: compact ? '0 0 auto' : 1,
          opacity: actif ? 1 : 0.4, cursor: actif ? 'pointer' : 'not-allowed',
          '--sion-range-progress': `${Math.round(volume * 100)}%`,
        } as React.CSSProperties}
      />
      <span style={{ minWidth: 30, textAlign: 'right', fontSize: 11, opacity: actif ? 1 : 0.4 }}>{Math.round(volume * 100)}%</span>
    </div>
  );

  const champRecherche = (
    <input
      value={recherche}
      onChange={(e) => setRecherche(e.target.value)}
      placeholder={t("memeboard.search")}
      style={{
        flex: compact ? '0 1 200px' : 1, minWidth: 0, boxSizing: 'border-box',
        padding: compact ? '4px 10px' : '8px 12px', borderRadius: compact ? 999 : 12,
        border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-container)',
        color: 'var(--color-on-surface)', fontSize: compact ? 12 : 13, fontFamily: 'inherit', outline: 'none',
      }}
    />
  );

  const boutonAjouter = peutEnvoyer && (
    <button
      type="button"
      onClick={() => setImport(true)}
      title={t("memeboard.add")}
      style={{
        width: compact ? 28 : 36, height: compact ? 28 : 36, flexShrink: 0, borderRadius: compact ? 999 : 12,
        border: 'none', background: 'var(--color-primary)', color: 'var(--color-on-primary)',
        cursor: 'pointer', fontSize: compact ? 17 : 20, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
      }}
    >+</button>
  );

  const fermer = (
    <button
      type="button"
      onClick={() => useLayoutStore.getState().closeDockPanel("memeboard")}
      title={t("memeboard.close")}
      style={{ flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', fontSize: compact ? 18 : 20, padding: 2, lineHeight: 1 }}
    >×</button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <style>{`.meme-tuile:hover .meme-suppr { display: flex !important; }`}</style>
      {compact ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, padding: '5px 10px', borderBottom: '1px solid var(--color-outline-variant)' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-on-surface)', flexShrink: 0 }}>{t("memeboard.title")}</span>
          <span style={{ fontSize: 11, color: 'var(--color-on-surface-variant)', flexShrink: 0 }}>{t("memeboard.count", { count: memes.length })}</span>
          <div style={{ flex: 1 }} />
          {roomId && champRecherche}
          {roomId && boutonAjouter}
          {reglageVolume}
          {fermer}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-on-surface)' }}>{t("memeboard.title")}</span>
              <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("memeboard.count", { count: memes.length })}</span>
            </div>
            {fermer}
          </div>
          {roomId && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 16px 12px' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {champRecherche}
                {boutonAjouter}
              </div>
              {reglageVolume}
            </div>
          )}
        </>
      )}

      {message && (
        <div style={{ margin: '0 16px 8px', padding: '6px 10px', borderRadius: 8, fontSize: 12, background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)' }}>
          {message}
        </div>
      )}

      {!roomId ? (
        <div style={{ padding: 20, fontSize: 12, color: 'var(--color-outline)', textAlign: 'center' }}>{t("memeboard.noRoom")}</div>
      ) : visibles.length === 0 ? (
        <div style={{ padding: 20, fontSize: 12, color: 'var(--color-outline)', textAlign: 'center' }}>
          {memes.length === 0 ? t("memeboard.empty") : t("memeboard.noMatch")}
        </div>
      ) : (
        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto', padding: compact ? '8px 10px' : '4px 16px 16px',
          display: 'grid', gap: 10, alignContent: 'start',
          gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))',
        }}>
          {visibles.map((m) => {
            const apercu = m.apercuMxc ? mxcToHttp(m.apercuMxc) : null;
            const peutSupprimer = m.senderId === moi || peutModerer;
            return (
              <div
                key={m.eventId}
                className="meme-tuile"
                onClick={() => void lancer(m)}
                title={actif ? m.label : t("memeboard.disabledHint")}
                style={{
                  position: 'relative', display: 'flex', flexDirection: 'column', gap: 6,
                  padding: 6, borderRadius: 12, cursor: actif ? 'pointer' : 'not-allowed',
                  border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-container)',
                  opacity: actif ? 1 : 0.45, transition: 'border-color 120ms',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-outline-variant)'; }}
              >
                <div style={{
                  aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden',
                  background: 'var(--color-surface-container-highest)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28,
                }}>
                  {apercu
                    ? <img src={apercu} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : (m.emoji || '🎬')}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.emoji ? `${m.emoji} ` : ''}{m.label}
                </div>
                {peutSupprimer && (
                  <button
                    type="button"
                    className="meme-suppr"
                    onClick={(e) => { e.stopPropagation(); void supprimer(m); }}
                    title={t("memeboard.delete")}
                    style={{
                      display: 'none', position: 'absolute', top: 10, right: 10, width: 24, height: 24,
                      borderRadius: 999, border: 'none', cursor: 'pointer', alignItems: 'center', justifyContent: 'center',
                      background: 'var(--color-error)', color: 'var(--color-on-error)', fontSize: 14, lineHeight: 1,
                    }}
                  >×</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {import_ && (
        <MemeImportModal
          onClose={() => setImport(false)}
          onEnvoye={() => { setImport(false); rafraichirRef.current(); }}
        />
      )}
    </div>
  );
}

/** Import d'un meme : une source, l'extrait choisi à l'œil et à l'oreille, un
 *  essai sur son propre écran, puis l'envoi. */
function MemeImportModal({ onClose, onEnvoye }: { onClose: () => void; onEnvoye: () => void }) {
  const { t } = useTranslation();
  const [fichier, setFichier] = useState<File | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [analyse, setAnalyse] = useState<MemeAnalyse | null>(null);
  const [lien, setLien] = useState(false);
  const [nom, setNom] = useState("");
  const [emoji, setEmoji] = useState("");
  const [region, setRegion] = useState({ debut: 0, fin: MEME_DUREE_MAX_MS });
  // Préparation gardée tant que l'extrait ne bouge pas : « Tester » puis
  // « Envoyer » ne réencodent qu'une fois.
  const [prepare, setPrepare] = useState<{ cle: string; resultat: MemePrepare } | null>(null);
  const [occupe, setOccupe] = useState<null | "analyse" | "tester" | "envoyer">(null);
  const [essai, setEssai] = useState<string | null>(null);
  const finirEssai = useCallback(() => {
    setEssai(null);
    libererLecteurActif(ESSAI);
  }, []);
  useEffect(() => () => libererLecteurActif(ESSAI), []);
  const [erreur, setErreur] = useState<string | null>(null);
  const entree = useRef<HTMLInputElement>(null);
  const cle = `${source}:${region.debut}:${region.fin}`;
  const boutonEmoji = useRef<HTMLButtonElement>(null);
  const [selecteur, setSelecteur] = useState<{ left: number; top: number } | null>(null);

  // Même principe que l'envoi d'un son : le sélecteur est en position fixe,
  // sans quoi la fenêtre, qui défile, le rognerait. Il s'ouvre sous le
  // bouton, ou au-dessus quand la place manque.
  const placerSelecteur = useCallback(() => {
    const r = boutonEmoji.current?.getBoundingClientRect();
    if (!r) return;
    const dessous = window.innerHeight - r.bottom - EMOJI_ECART >= EMOJI_PANNEAU_H;
    setSelecteur({
      left: Math.max(EMOJI_ECART, Math.min(r.left, window.innerWidth - EMOJI_PANNEAU_L - EMOJI_ECART)),
      top: dessous ? r.bottom + EMOJI_ECART : Math.max(EMOJI_ECART, r.top - EMOJI_PANNEAU_H - EMOJI_ECART),
    });
  }, []);
  const selecteurOuvert = selecteur !== null;
  useEffect(() => {
    if (!selecteurOuvert) return;
    window.addEventListener("scroll", placerSelecteur, true);
    window.addEventListener("resize", placerSelecteur);
    return () => {
      window.removeEventListener("scroll", placerSelecteur, true);
      window.removeEventListener("resize", placerSelecteur);
    };
  }, [selecteurOuvert, placerSelecteur]);

  const choisir = async (f: File) => {
    setFichier(f);
    setSource(null);
    setAnalyse(null);
    setPrepare(null);
    setErreur(null);
    if (!nom) setNom(f.name.replace(/\.[^.]+$/, "").slice(0, 40));
    setOccupe("analyse");
    try {
      const chemin = await deposerSource(f);
      const a = await analyserMeme(chemin);
      setSource(chemin);
      setAnalyse(a);
      setRegion({ debut: 0, fin: Math.min(MEME_DUREE_MAX_MS, a.duree_ms) });
    } catch (err) {
      setErreur(`${t("memeboard.prepareError")} — ${String(err)}`);
    } finally {
      setOccupe(null);
    }
  };

  const preparer = async (): Promise<MemePrepare> => {
    if (prepare?.cle === cle) return prepare.resultat;
    if (!source) throw new Error("aucune source");
    const resultat = await preparerMeme(source, region.debut, region.fin - region.debut);
    setPrepare({ cle, resultat });
    return resultat;
  };

  const tester = async () => {
    setOccupe("tester");
    setErreur(null);
    try {
      const p = await preparer();
      definirLecteurActif(ESSAI);
      setEssai(p.video);
    } catch (err) {
      setErreur(`${t("memeboard.prepareError")} — ${String(err)}`);
    } finally {
      setOccupe(null);
    }
  };

  const envoyer = async () => {
    setOccupe("envoyer");
    setErreur(null);
    try {
      await envoyerMeme(await preparer(), nom, emoji.trim() || null);
      onEnvoye();
    } catch (err) {
      setErreur(`${t("memeboard.sendError")} — ${String(err)}`);
      setOccupe(null);
    }
  };

  const champ: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 10,
    border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-container)',
    color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit', outline: 'none',
  };
  const bouton = (principal: boolean, actif = true): React.CSSProperties => ({
    padding: '8px 14px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600,
    fontFamily: 'inherit', cursor: actif ? 'pointer' : 'not-allowed', opacity: actif ? 1 : 0.5,
    background: principal ? 'var(--color-primary)' : 'var(--color-surface-container-highest)',
    color: principal ? 'var(--color-on-primary)' : 'var(--color-on-surface)',
  });
  const pret = !!analyse && occupe === null;

  // Le fond ne ferme PAS la fenêtre : un clic à côté faisait perdre la
  // source choisie et le découpage (23/09). On ferme par « Annuler ».
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'var(--color-scrim, rgba(0,0,0,0.5))', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        style={{
          width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 12, padding: 20, borderRadius: 16,
          background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700 }}>{t("memeboard.importTitle")}</div>
        <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("memeboard.limits")}</div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
          <button type="button" style={bouton(false)} onClick={() => entree.current?.click()}>{t("memeboard.fromFile")}</button>
          <button type="button" style={bouton(false)} onClick={() => setLien(true)}>{t("memeboard.fromLink")}</button>
          {fichier && (
            <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fichier.name}
            </span>
          )}
          <input
            ref={entree}
            type="file"
            accept="video/*,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void choisir(f); e.target.value = ""; }}
          />
        </div>

        {fichier && (
          <div style={{ display: 'flex', gap: 8 }}>
            <label style={{ flex: 1, fontSize: 12 }}>
              {t("memeboard.name")}
              <input value={nom} maxLength={40} onChange={(e) => setNom(e.target.value)} style={champ} />
            </label>
            <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column' }}>
              {t("memeboard.emoji")}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <button
                  ref={boutonEmoji}
                  type="button"
                  onClick={() => (selecteurOuvert ? setSelecteur(null) : placerSelecteur())}
                  title={t("memeboard.emoji")}
                  style={{
                    width: 38, height: 36, borderRadius: 10, border: '1px solid var(--color-outline-variant)',
                    background: 'var(--color-surface-container)', color: 'var(--color-on-surface)',
                    fontSize: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >{emoji || '🎬'}</button>
                {emoji && (
                  <button
                    type="button"
                    onClick={() => setEmoji("")}
                    title={t("memeboard.emojiClear")}
                    style={{ border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', fontSize: 16, padding: 2 }}
                  >×</button>
                )}
              </div>
            </div>
          </div>
        )}

        {occupe === "analyse" && (
          <div style={{ fontSize: 12, color: 'var(--color-outline)' }}>{t("memeboard.analysing")}</div>
        )}
        {source && analyse && (
          <MemeTrimmer
            source={source}
            dureeMs={analyse.duree_ms}
            onChange={(debut, fin) => setRegion({ debut, fin })}
            essai={essai}
            onFinEssai={finirEssai}
          />
        )}

        {prepare?.cle === cle && (
          <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
            {t("memeboard.prepared", {
              duree: (prepare.resultat.duree_ms / 1000).toFixed(1),
              poids: (prepare.resultat.taille / 1024 / 1024).toFixed(1),
            })}
          </div>
        )}
        {erreur && <div style={{ fontSize: 12, color: 'var(--color-error)' }}>{erreur}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" style={bouton(false)} onClick={onClose}>{t("memeboard.cancel")}</button>
          <button type="button" style={bouton(false, pret)} disabled={!pret} onClick={() => void tester()}>
            {occupe === "tester" ? t("memeboard.preparing") : t("memeboard.test")}
          </button>
          <button type="button" style={bouton(true, pret)} disabled={!pret} onClick={() => void envoyer()}>
            {occupe === "envoyer" ? t("memeboard.sending") : t("memeboard.send")}
          </button>
        </div>
      </div>

      {selecteur && (
        <>
          <div onClick={() => setSelecteur(null)} style={{ position: 'fixed', inset: 0, zIndex: 1001 }} />
          <div style={{
            position: 'fixed', left: selecteur.left, top: selecteur.top, width: EMOJI_PANNEAU_L, height: EMOJI_PANNEAU_H,
            zIndex: 1002, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: 12,
            background: 'var(--color-surface-container-high)', border: '1px solid var(--color-outline-variant)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          }}>
            <EmojiGridPanel emojiSize={32} onPick={(e) => { setEmoji(e); setSelecteur(null); }} />
          </div>
        </>
      )}

      {lien && (
        <div>
          <Suspense fallback={null}>
            <ExternalVideoImport
              onClose={() => setLien(false)}
              onImported={(f) => { setLien(false); void choisir(f); }}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
