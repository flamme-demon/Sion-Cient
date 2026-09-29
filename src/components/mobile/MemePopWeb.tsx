import { useEffect, useRef } from "react";
import { useMemePopStore, type MemeAffiche } from "../../stores/useMemePopStore";
import { MEME_DUREE_MAX_MS } from "../../services/memeboardService";

/** Un meme reçu, posé par-dessus Sion (téléphone). Retiré à la fin de la
 *  vidéo, ou au bout de 10 s comme sur PC. */
function Meme({ meme }: { meme: MemeAffiche }) {
  const video = useRef<HTMLVideoElement>(null);
  const retirer = useMemePopStore((s) => s.retirer);
  useEffect(() => {
    if (video.current) video.current.volume = Math.max(0, Math.min(1, meme.volume));
    const fin = window.setTimeout(() => retirer(meme.id), MEME_DUREE_MAX_MS);
    return () => window.clearTimeout(fin);
  }, [meme.id, meme.volume, retirer]);
  return (
    <div style={{
      position: "fixed", left: `${meme.x}%`, top: `${meme.y}%`, zIndex: 950,
      width: "min(56vw, 320px)", pointerEvents: "none",
      borderRadius: 14, overflow: "hidden", boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
      background: "var(--color-surface-container-highest)",
    }}>
      <video
        ref={video}
        src={meme.url}
        autoPlay
        playsInline
        onEnded={() => retirer(meme.id)}
        onError={() => retirer(meme.id)}
        style={{ display: "block", width: "100%" }}
      />
      {meme.emetteur && (
        <div style={{
          padding: "3px 8px", fontSize: 11, color: "var(--color-on-surface-variant)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {meme.emetteur}
        </div>
      )}
    </div>
  );
}

/** Memes reçus sur téléphone (voir `useMemePopStore`). */
export function MemePopWeb() {
  const memes = useMemePopStore((s) => s.memes);
  return <>{memes.map((m) => <Meme key={m.id} meme={m} />)}</>;
}
