// Lecteur vidéo natif — la vidéo est décodée par Rust et peinte dans la
// surface native, pas par le moteur web.
//
// Ce composant ne montre donc aucune image lui-même : il réserve un rectangle
// à l'écran, l'annonce à Rust, et la surface vient s'y superposer. C'est
// exactement le mécanisme du partage d'écran, qui fonctionne chez tous les
// utilisateurs — y compris ceux dont le `<video>` du webview ne rend qu'un
// cadre vert. Voir docs/lecteur-video-natif.md.
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SENDER_LECTEUR,
  etatLecteurVideo,
  fermerLecteurVideo,
  ouvrirLecteurVideo,
  pauseLecteurVideo,
  registerNativeVideoSurface,
  volumeLecteurVideo,
  type EtatLecteurVideo,
} from "../../services/voiceNativeService";

interface Props {
  /** Chemin local ou URL HTTP — ffmpeg lit les deux. */
  source: string;
  titre?: string;
  onClose: () => void;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function NativeVideoPlayer({ source, titre, onClose }: Props) {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLCanvasElement>(null);
  const [etat, setEtat] = useState<EtatLecteurVideo | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);

  // La surface doit être déclarée AVANT d'ouvrir le fichier : les premières
  // images arrivent dès l'ouverture, et sans rectangle publié elles tombent.
  useEffect(() => {
    const canvas = surfaceRef.current;
    if (!canvas) return;
    let vivant = true;
    let liberer: (() => void) | null = null;

    void (async () => {
      liberer = await registerNativeVideoSurface(canvas, SENDER_LECTEUR);
      if (!vivant) {
        liberer?.();
        return;
      }
      try {
        const e = await ouvrirLecteurVideo(source);
        if (vivant) setEtat(e);
      } catch (err) {
        if (vivant) setErreur(String(err));
      }
    })();

    return () => {
      vivant = false;
      void fermerLecteurVideo();
      liberer?.();
    };
  }, [source]);

  // Progression : Rust tient la position, le front la relit. Une seconde
  // suffit — on n'affiche que des minutes et des secondes.
  useEffect(() => {
    if (!etat?.actif) return;
    const timer = window.setInterval(() => {
      void etatLecteurVideo().then((e) =>
        setEtat((ancien) =>
          e.actif ? { ...e, largeur: ancien?.largeur ?? 0, hauteur: ancien?.hauteur ?? 0 } : e,
        ),
      );
      // Quatre fois par seconde : assez pour une barre qui avance sans
      // saccade, assez peu pour ne pas encombrer le pont avec Rust.
    }, 250);
    return () => window.clearInterval(timer);
  }, [etat?.actif]);

  useEffect(() => {
    const touche = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", touche);
    return () => window.removeEventListener("keydown", touche);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 3000,
        background: 'rgba(0,0,0,0.92)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
      }}
    >
      {erreur ? (
        <div style={{ color: 'var(--color-error)', fontSize: 13, maxWidth: 480, textAlign: 'center' }}>
          {t("chat.videoPlayFailed", { defaultValue: "Lecture impossible" })} — {erreur}
        </div>
      ) : (
        // Le canvas ne porte AUCUN pixel : son tampon reste à 1×1, c'est la
        // surface native qui peint par-dessus. Il lui faut donc une largeur
        // CSS explicite, sinon la mise en page le réduit à sa taille
        // intrinsèque — mesuré le 21/09 : une sous-surface de 2×52 pixels,
        // invisible, alors que les images arrivaient normalement.
        //
        // `--sion-share-max-height` est la variable que le service utilise
        // pour borner la largeur d'après le ratio de la source.
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '92vw',
            display: 'flex',
            justifyContent: 'center',
            ["--sion-share-max-height" as string]: '80vh',
          } as React.CSSProperties}
        >
          <canvas
            ref={surfaceRef}
            style={{ width: '100%', display: 'block', borderRadius: 8, background: 'transparent' }}
          />
        </div>
      )}

      <div
        onClick={(e) => e.stopPropagation()}
        style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--color-on-surface)', fontSize: 12 }}
      >
        {titre && <span style={{ opacity: 0.75, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{titre}</span>}
        {etat?.actif && (
          <button
            onClick={() => {
              const versPause = !etat.en_pause;
              void pauseLecteurVideo(versPause);
              setEtat({ ...etat, en_pause: versPause });
            }}
            title={etat.en_pause ? t("chat.play", { defaultValue: "Lire" }) : t("chat.pause", { defaultValue: "Pause" })}
            style={{
              width: 30, height: 30, borderRadius: 15, border: 'none', cursor: 'pointer',
              background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)',
              fontSize: 13, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {etat.en_pause ? "▶" : "❚❚"}
          </button>
        )}
        {etat && etat.duree_ms > 0 && (
          <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.75 }}>
            {mmss(etat.position_ms)} / {mmss(etat.duree_ms)}
          </span>
        )}
        {/* Barre de progression en lecture seule : se déplacer dans le film
            demande de relancer ffmpeg avec `-ss`, ce n'est pas encore fait. */}
        {etat && etat.duree_ms > 0 && (
          <div
            title={t("chat.seekUnavailable", { defaultValue: "Déplacement pas encore disponible" })}
            style={{
              width: 200, height: 4, borderRadius: 2, overflow: 'hidden',
              background: 'var(--color-surface-container-highest)',
            }}
          >
            <div
              style={{
                width: `${Math.min(100, (etat.position_ms / etat.duree_ms) * 100)}%`,
                height: '100%',
                background: 'var(--color-primary)',
              }}
            />
          </div>
        )}
        {etat?.a_du_son && (
          <input
            type="range"
            min={0}
            max={150}
            value={Math.round(volume * 100)}
            onChange={(e) => {
              const v = Number(e.target.value) / 100;
              setVolume(v);
              void volumeLecteurVideo(v);
            }}
            title={t("chat.volume", { defaultValue: "Volume" })}
            style={{ width: 90, accentColor: 'var(--color-primary)' }}
          />
        )}
        <button
          onClick={onClose}
          style={{
            padding: '6px 14px',
            borderRadius: 16,
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'inherit',
            background: 'var(--color-surface-container-high)',
            color: 'var(--color-on-surface)',
          }}
        >
          {t("chat.close", { defaultValue: "Fermer" })}
        </button>
      </div>
    </div>
  );
}
