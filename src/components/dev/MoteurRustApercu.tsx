import { useEffect, useState } from "react";
import {
  chargerHistorique, connecter, deconnecter, ecartHorloge, envoyerTexte, epingles as lireEpingles, fils as lireFils, poker,
  reagir, reprendre,
  salons as lireSalons, surEtat, surMessages, surSalons, urlLecture, type EtatConnexion, type FilSalon,
} from "../../services/matrixCore";
import type { PinnedSummary } from "../../services/matrixService";
import type { Channel, ChatMessage } from "../../types/matrix";

/**
 * Écran de développement du moteur Matrix Rust (tranche T0).
 *
 * Affiché à la place de Sion quand l'appli est lancée avec
 * `SION_MATRIX_MOTEUR=rust` et compilée avec la feature `moteur-matrix-rust`.
 * Il valide les fondations — connexion d'un nouvel appareil, reprise de la
 * session au lancement suivant, déconnexion — avant que le reste de
 * l'interface ne soit branché sur ce moteur ; T1 y ajoute la liste des
 * salons (texte, vocaux avec leurs participants, MP), T2 le fil d'un salon
 * (médias servis par `sion-media`, historique, épinglés), T3 la saisie
 * (texte, poke, réaction 👍). Textes non
 * traduits : c'est un outil de développement, pas un écran livré.
 */
export function MoteurRustApercu() {
  const [etat, setEtat] = useState<EtatConnexion>({ etat: "connexion" });
  const [serveur, setServeur] = useState("sionchat.fr");
  const [identifiant, setIdentifiant] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [liste, setListe] = useState<Channel[]>([]);
  const [ecart, setEcart] = useState(0);
  const [fils, setFils] = useState<Record<string, FilSalon>>({});
  const [ouvert, setOuvert] = useState<string | null>(null);

  useEffect(() => {
    const desabonnements: (() => void)[] = [];
    let actif = true;
    const garder = (d: () => void) => (actif ? desabonnements.push(d) : d());
    void surEtat((e) => {
      if (!actif) return;
      setEtat(e);
      if (e.etat === "connecte") {
        lireSalons().then((l) => actif && setListe(l)).catch(() => {});
        ecartHorloge().then((m) => actif && setEcart(m)).catch(() => {});
        lireFils()
          .then((tous) => actif && setFils((courants) => ({ ...Object.fromEntries(tous.map((f) => [f.salon, f])), ...courants })))
          .catch(() => {});
      }
      if (e.etat === "deconnecte") {
        setListe([]);
        setFils({});
        setOuvert(null);
      }
    }).then(garder);
    void surSalons((l) => actif && setListe(l)).then(garder);
    void surMessages((f) => actif && setFils((courants) => ({ ...courants, [f.salon]: f }))).then(garder);
    // Reprise automatique : c'est le critère de T0 (relancer sans se reconnecter).
    reprendre().catch((e) => actif && setErreur(String(e)));
    return () => {
      actif = false;
      desabonnements.forEach((d) => d());
    };
  }, []);

  const agir = async (action: () => Promise<unknown>) => {
    setOccupe(true);
    setErreur(null);
    try {
      await action();
    } catch (e) {
      setErreur(String(e));
    } finally {
      setOccupe(false);
    }
  };

  const champ = {
    padding: '8px 10px', borderRadius: 8, width: '100%', boxSizing: 'border-box' as const,
    border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-container-high)',
    color: 'var(--color-on-surface)', fontSize: 14,
  };
  const bouton = {
    padding: '8px 14px', borderRadius: 999, border: 'none', cursor: occupe ? 'wait' : 'pointer',
    background: 'var(--color-primary)', color: 'var(--color-on-primary)', fontWeight: 700,
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 16,
      boxSizing: 'border-box', background: 'var(--color-surface)', color: 'var(--color-on-surface)',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        width: 420, flexShrink: 0, padding: 24, borderRadius: 16, display: 'flex', flexDirection: 'column', gap: 14,
        background: 'var(--color-surface-container)', border: '1px solid var(--color-outline-variant)',
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Moteur Matrix Rust</div>
          <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
            Écran de développement (T0). Le reste de Sion n'est pas encore branché sur ce moteur.
          </div>
        </div>

        <div style={{ fontSize: 14 }}>
          <b>État :</b>{" "}
          {etat.etat === "connecte" && <>connecté — {etat.utilisateur}, appareil <code>{etat.appareil}</code></>}
          {etat.etat === "connexion" && "connexion…"}
          {etat.etat === "deconnecte" && "déconnecté"}
          {etat.etat === "erreur" && <span style={{ color: 'var(--color-error)' }}>erreur — {etat.message}</span>}
        </div>

        {etat.etat === "connecte" ? (
          <button style={bouton} disabled={occupe} onClick={() => void agir(deconnecter)}>
            Se déconnecter (supprime cet appareil)
          </button>
        ) : (
          <form
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              void agir(() => connecter(serveur, identifiant, motDePasse).then(() => setMotDePasse("")));
            }}
          >
            <input style={champ} value={serveur} onChange={(e) => setServeur(e.target.value)} placeholder="Serveur" />
            <input style={champ} value={identifiant} onChange={(e) => setIdentifiant(e.target.value)} placeholder="Identifiant" autoComplete="username" />
            <input style={champ} type="password" value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} placeholder="Mot de passe" autoComplete="current-password" />
            <button style={bouton} type="submit" disabled={occupe || !identifiant || !motDePasse}>
              Se connecter comme nouvel appareil
            </button>
          </form>
        )}

        {erreur && <div style={{ fontSize: 12, color: 'var(--color-error)' }}>{erreur}</div>}

        {ecart !== 0 && (
          <div style={{ fontSize: 12, color: 'var(--color-error)' }}>
            Horloge locale décalée de {ecart} min par rapport au serveur.
          </div>
        )}

        {etat.etat === "connecte" && <ListeSalons liste={liste} fils={fils} ouvert={ouvert} ouvrir={setOuvert} />}
      </div>
      {etat.etat === "connecte" && ouvert && (
        <Fil key={ouvert} salon={liste.find((c) => c.id === ouvert)} fil={fils[ouvert]} id={ouvert} />
      )}
    </div>
  );
}

function ListeSalons({ liste, fils, ouvert, ouvrir }: {
  liste: Channel[]; fils: Record<string, FilSalon>; ouvert: string | null; ouvrir: (id: string) => void;
}) {
  const visibles = liste.filter((c) => !c.isSoundboard);
  const groupes: [string, Channel[]][] = [
    ["Salons texte", visibles.filter((c) => !c.hasVoice && !c.isDM)],
    ["Salons vocaux", visibles.filter((c) => c.hasVoice && !c.isDM)],
    ["Messages privés", visibles.filter((c) => c.isDM)],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 360, overflowY: 'auto' }}>
      <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
        {liste.length} salons reçus du cœur Rust ({liste.length - visibles.length} soundboard masqué).
      </div>
      {groupes.map(([titre, salons]) => salons.length > 0 && (
        <div key={titre}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface-variant)', marginBottom: 4 }}>{titre}</div>
          {salons.map((c) => (
            <button
              key={c.id}
              onClick={() => ouvrir(c.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', border: 'none', font: 'inherit', color: 'inherit',
                fontSize: 14, padding: '3px 6px', borderRadius: 6, cursor: 'pointer',
                background: c.id === ouvert ? 'var(--color-surface-container-highest)' : 'transparent',
              }}
            >
              {c.hasVoice ? "🔊" : c.isDM ? "💬" : "#"} {c.name}
              <span style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
                {" "}({fils[c.id]?.messages.length ?? 0})
              </span>
              {c.voiceUsers.length > 0 && (
                <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
                  {" — "}{c.voiceUsers.map((u) => `${u.name}${u.muted ? " (muet)" : ""}${u.deafened ? " (sourd)" : ""}`).join(", ")}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Fil d'un salon. L'ouvrir remonte ~30 messages d'historique et envoie
 *  l'accusé de lecture, comme l'ouverture d'un salon dans Sion. */
function Fil({ id, salon, fil }: { id: string; salon?: Channel; fil?: FilSalon }) {
  // Monté à neuf pour chaque salon (clé = salon) : l'ouverture charge d'office.
  const [charge, setCharge] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [resumes, setResumes] = useState<PinnedSummary[]>([]);

  const remonter = () =>
    chargerHistorique(id)
      .catch((e) => setErreur(String(e)))
      .finally(() => setCharge(false));
  const plus = () => {
    setCharge(true);
    setErreur(null);
    void remonter();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- une fois à l'ouverture
  useEffect(() => void remonter(), []);
  const nbEpingles = fil?.epingles.length ?? 0;
  useEffect(() => {
    if (nbEpingles > 0) lireEpingles(id).then(setResumes).catch((e) => setErreur(String(e)));
  }, [id, nbEpingles]);

  return (
    <div style={{
      flex: 1, maxWidth: 720, height: 'calc(100vh - 32px)', display: 'flex', flexDirection: 'column', gap: 8,
      padding: 16, borderRadius: 16, boxSizing: 'border-box',
      background: 'var(--color-surface-container)', border: '1px solid var(--color-outline-variant)',
    }}>
      <div style={{ fontSize: 16, fontWeight: 800 }}>
        {salon?.name ?? id}
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--color-on-surface-variant)' }}>
          {" "}— {fil?.messages.length ?? 0} messages{nbEpingles > 0 && `, ${nbEpingles} épinglé(s)`}
        </span>
      </div>
      {nbEpingles > 0 && resumes.length > 0 && (
        <div style={{ fontSize: 12, padding: 8, borderRadius: 8, background: 'var(--color-surface-container-high)' }}>
          {resumes.map((r) => (
            <div key={r.eventId}>
              📌 <b>{r.sender}</b> : {r.text || r.media || "(vide)"}
              {!r.loaded && <span style={{ color: 'var(--color-on-surface-variant)' }}> (hors du fil chargé)</span>}
            </div>
          ))}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {fil?.aPlus !== false && (
          <button
            onClick={plus}
            disabled={charge}
            style={{
              alignSelf: 'center', padding: '4px 12px', borderRadius: 999, border: '1px solid var(--color-outline-variant)',
              background: 'transparent', color: 'var(--color-on-surface)', cursor: charge ? 'wait' : 'pointer',
            }}
          >
            {charge ? "chargement…" : "Charger plus"}
          </button>
        )}
        {fil?.aPlus === false && (
          <div style={{ alignSelf: 'center', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>Début du salon</div>
        )}
        {erreur && <div style={{ fontSize: 12, color: 'var(--color-error)' }}>{erreur}</div>}
        {fil?.messages.map((m) => (
          <Bulle
            key={m.eventId ?? m.id}
            m={m}
            epingle={fil.epingles.includes(String(m.eventId))}
            reagir={() => m.eventId && reagir(id, m.eventId, "👍").catch((e) => setErreur(String(e)))}
          />
        ))}
      </div>
      <Saisie salon={id} signaler={setErreur} />
    </div>
  );
}

/** Saisie : Entrée envoie ; le message revient par le fil, comme tout autre. */
function Saisie({ salon, signaler }: { salon: string; signaler: (e: string | null) => void }) {
  const [texte, setTexte] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const envoyer = () => {
    const corps = texte.trim();
    if (!corps || envoi) return;
    setEnvoi(true);
    signaler(null);
    envoyerTexte(salon, corps)
      .then(() => setTexte(""))
      .catch((e) => signaler(String(e)))
      .finally(() => setEnvoi(false));
  };
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input
        value={texte}
        onChange={(e) => setTexte(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") envoyer(); }}
        placeholder="Message (moteur Rust)"
        disabled={envoi}
        style={{
          flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
          background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)', fontSize: 14,
        }}
      />
      <button
        onClick={() => poker(salon).catch((e) => signaler(String(e)))}
        title="Poke"
        style={{ padding: '8px 12px', borderRadius: 999, border: '1px solid var(--color-outline-variant)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
      >
        👉
      </button>
    </div>
  );
}

function Bulle({ m, epingle, reagir }: { m: ChatMessage; epingle: boolean; reagir: () => void }) {
  const discret = { fontSize: 11, color: 'var(--color-on-surface-variant)' };
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 14 }}>
      {m.avatarUrl
        ? <img src={m.avatarUrl} alt="" style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0 }} />
        : <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: 'var(--color-surface-container-highest)' }} />}
      <div style={{ minWidth: 0 }}>
        <div>
          <b>{m.user}</b> <span style={discret}>{m.time}{m.edited && " (modifié)"}{epingle && " 📌"}{m.msgtype && m.msgtype !== "m.text" && ` ${m.msgtype}`}</span>
          {" "}
          <button
            onClick={reagir}
            title="Réagir 👍"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, opacity: 0.5, padding: 0 }}
          >
            +👍
          </button>
        </div>
        {m.replyTo && (
          <div style={{ ...discret, borderLeft: '2px solid var(--color-outline-variant)', paddingLeft: 6 }}>
            ↪ {m.replyTo.user ?? m.replyTo.senderId ?? "?"} : {m.replyTo.text ?? m.replyTo.attachmentName ?? "…"}
          </div>
        )}
        {m.poll ? (
          <div>📊 {m.poll.question} — {m.poll.answers.map((a) => a.text).join(" / ")}{m.poll.ended && " (clos)"}</div>
        ) : (
          m.text && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</div>
        )}
        {m.attachments?.map((a) => (
          <div key={a.id}>
            {a.mimeType.startsWith("image/") ? (
              <img src={a.thumbnailUrl ?? a.url} alt={a.name} style={{ maxWidth: 320, maxHeight: 240, borderRadius: 8 }} />
            ) : a.mimeType.startsWith("audio/") || a.mimeType.startsWith("video/") ? (
              <Lecture url={a.url} video={a.mimeType.startsWith("video/")} />
            ) : null}
            <div style={discret}>{a.name} — {Math.round(a.size / 1024)} Ko</div>
          </div>
        ))}
        {m.reactions && m.reactions.length > 0 && (
          <div style={discret}>{m.reactions.map((r) => `${r.emoji} ${r.count}`).join("  ")}</div>
        )}
      </div>
    </div>
  );
}

/** Son ou vidéo : lus par le serveur média local (voir `urlLecture`). */
function Lecture({ url, video }: { url: string; video: boolean }) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let vivant = true;
    void urlLecture(url).then((u) => vivant && setSource(u));
    return () => { vivant = false; };
  }, [url]);
  if (!source) return null;
  return video
    ? <video controls preload="metadata" src={source} style={{ maxWidth: 320, maxHeight: 240, borderRadius: 8 }} />
    : <audio controls preload="metadata" src={source} style={{ maxWidth: 320 }} />;
}
