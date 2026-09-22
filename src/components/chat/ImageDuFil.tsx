// Image du fil, déchargée quand elle sort de l'écran.
//
// Une image reste décodée en mémoire tant que son `<img>` est monté, où qu'elle
// se trouve dans le défilement. Mesuré le 22/09 : après une remontée complète
// de l'historique, 349 images pour 264 Mo — environ 0,9 Mo pièce, la taille
// d'une vignette décodée. C'est ce qui a imposé le plafond de remontée, bien
// plus que la timeline du SDK ou le chiffrement (dont le module WebAssembly ne
// pèse que 6 Mo).
//
// On ne monte donc l'image que lorsqu'elle approche de la vue, et on la
// démonte lorsqu'elle s'en éloigne. La place reste réservée — le fil ne
// sursaute pas — et le cache du moteur rend le retour immédiat.
import { useEffect, useRef, useState, type CSSProperties } from "react";

interface Props {
  src: string | null | undefined;
  alt: string;
  style?: CSSProperties;
  onClick?: () => void;
  onError?: () => void;
  title?: string;
}

/** Marge autour de la vue où l'image reste montée.
 *
 *  Assez large pour qu'un défilement normal ne fasse jamais apparaître de
 *  place vide, assez étroite pour qu'une remontée de plusieurs centaines de
 *  messages n'en garde qu'une poignée en mémoire. */
const MARGE = "600px";

export function ImageDuFil({ src, alt, style, onClick, onError, title }: Props) {
  const boiteRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = boiteRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      // Pas d'observateur : on montre tout, comme avant. Différé d'une image
      // pour ne pas poser d'état pendant l'effet lui-même.
      const t = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(t);
    }
    // L'observateur reste actif : contrairement au chargement paresseux
    // habituel, on veut aussi savoir quand l'image S'ÉLOIGNE.
    const io = new IntersectionObserver(
      (entrees) => setVisible(entrees.some((e) => e.isIntersecting)),
      { rootMargin: MARGE },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={boiteRef} style={{ ...style, overflow: 'hidden' }} onClick={onClick} title={title}>
      {visible && src ? (
        <img
          src={src}
          alt={alt}
          onError={onError}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        // Fond neutre à la place de l'image : la boîte garde ses dimensions,
        // donc le défilement ne bouge pas quand on décharge.
        <div style={{ width: '100%', height: '100%', background: 'var(--color-surface-container-high)' }} />
      )}
    </div>
  );
}
