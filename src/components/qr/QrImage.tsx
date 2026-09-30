import { useEffect, useState } from "react";
import * as core from "../../services/matrixCore";

/**
 * QR code dessiné par Sion (commande `qr_svg`) : texte (connexion d'un
 * téléphone) ou octets en base64 (QR de vérification Matrix). Toujours noir
 * sur blanc, quel que soit le thème : c'est ce que les caméras lisent le mieux.
 */
export function QrImage({ texte, octetsBase64, taille = 220, alt }: {
  texte?: string;
  octetsBase64?: string;
  taille?: number;
  alt: string;
}) {
  const cle = texte ?? octetsBase64 ?? "";
  // Image rattachée à sa source : un nouveau contenu n'affiche jamais l'ancien QR.
  const [image, setImage] = useState<{ cle: string; url: string | null; erreur?: string } | null>(null);
  const url = image?.cle === cle ? image.url : null;
  const erreur = image?.cle === cle ? image.erreur : undefined;

  useEffect(() => {
    let actif = true;
    const source = texte !== undefined ? { texte } : octetsBase64 !== undefined ? { octetsBase64 } : null;
    if (!source) return;
    core.qrSvg(source)
      .then((svg) => {
        if (actif) setImage({ cle: texte ?? octetsBase64 ?? "", url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
      })
      .catch((e: unknown) => {
        if (actif) setImage({ cle: texte ?? octetsBase64 ?? "", url: null, erreur: String(e) });
      });
    return () => { actif = false; };
  }, [texte, octetsBase64]);

  return (
    // Largeur fixe bornée par `max-width` : un `min(…, 100%)` s'effondrait à 0
    // dans un conteneur qui prend la taille de son contenu (fenêtre du PC).
    <div style={{
      width: taille, maxWidth: "100%", aspectRatio: "1", borderRadius: 12, background: "#fff", // theme-exempt : QR noir sur blanc
      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      color: "#b3261e", fontSize: 12, textAlign: "center", padding: erreur ? 12 : 0, boxSizing: "border-box", // theme-exempt : sur fond blanc
    }}>
      {url && <img src={url} alt={alt} style={{ display: "block", width: "100%", height: "100%", borderRadius: 12 }} />}
      {erreur}
    </div>
  );
}
