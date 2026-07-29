import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

/** Côté du rendu final, en pixels. 256 suffit pour un médaillon et reste léger. */
const OUT = 256;
/** Côté de la zone de recadrage affichée. */
const VIEW = 260;
const MAX_ZOOM = 5;

interface Props {
  file: File;
  /** Recadrage circulaire (avatars) plutôt que carré. */
  round?: boolean;
  onCancel: () => void;
  onCropped: (file: File) => void;
}

/**
 * Recadrage d'image avec déplacement et zoom.
 *
 * Sert aux portraits de voix comme aux avatars de compte : une photo contient
 * souvent plusieurs visages, et l'uploader telle quelle donne un médaillon
 * illisible. On produit toujours un carré de taille fixe, ce qui évite d'envoyer
 * une image de plusieurs Mo pour un affichage de 44 px.
 */
export function ImageCropper({ file, round = true, onCancel, onCropped }: Props) {
  const { t } = useTranslation();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    // Révoquer dans le nettoyage annulait un chargement encore en vol, et le
    // navigateur consignait un `net::ERR_FILE_NOT_FOUND` sur l'URL blob. On
    // libère donc une fois l'image décodée — après quoi l'URL ne sert plus —
    // et le nettoyage ne s'en charge que si ce moment n'est jamais venu.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    };
    image.onload = () => { setImg(image); release(); };
    image.onerror = release;
    image.src = url;
    return release;
  }, [file]);

  /** Échelle minimale pour que l'image couvre toute la zone : en-dessous, on
   *  laisserait des bords vides dans le médaillon. */
  const baseScale = img ? Math.max(VIEW / img.width, VIEW / img.height) : 1;

  /** Borne le déplacement pour que l'image couvre toujours la zone. */
  const clampOffset = useCallback(
    (o: { x: number; y: number }, s: number) => {
      if (!img) return o;
      const maxX = Math.max(0, (img.width * s - VIEW) / 2);
      const maxY = Math.max(0, (img.height * s - VIEW) / 2);
      return {
        x: Math.max(-maxX, Math.min(maxX, o.x)),
        y: Math.max(-maxY, Math.min(maxY, o.y)),
      };
    },
    [img],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const c = canvas.getContext("2d");
    if (!c) return;
    const s = baseScale * zoom;
    const w = img.width * s;
    const h = img.height * s;
    c.clearRect(0, 0, VIEW, VIEW);
    c.drawImage(img, (VIEW - w) / 2 + offset.x, (VIEW - h) / 2 + offset.y, w, h);
  }, [img, zoom, offset, baseScale]);

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset(clampOffset({ x: e.clientX - d.x, y: e.clientY - d.y }, baseScale * zoom));
  };
  const onPointerUp = () => { dragRef.current = null; };

  const onWheel = (e: React.WheelEvent) => {
    const next = Math.max(1, Math.min(MAX_ZOOM, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    setZoom(next);
    setOffset((o) => clampOffset(o, baseScale * next));
  };

  const confirm = () => {
    if (!img || busy) return;
    setBusy(true);
    // Rendu final : même cadrage, mais à la résolution de sortie.
    const out = document.createElement("canvas");
    out.width = OUT;
    out.height = OUT;
    const c = out.getContext("2d");
    if (!c) { setBusy(false); return; }
    const k = OUT / VIEW;
    const s = baseScale * zoom * k;
    const w = img.width * s;
    const h = img.height * s;
    c.drawImage(img, (OUT - w) / 2 + offset.x * k, (OUT - h) / 2 + offset.y * k, w, h);
    out.toBlob(
      (blob) => {
        setBusy(false);
        if (blob) onCropped(new File([blob], "portrait.jpg", { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.9,
    );
  };

  return (
    <div
      onClick={onCancel}
      // Cette boîte est en `fixed` : dans l'arbre React elle est souvent voisine
      // du panneau qui l'a ouverte, jamais dedans. Les fermetures « au clic en
      // dehors » doivent pouvoir la reconnaître, sans quoi chaque clic dedans
      // referme ce qui l'a ouverte.
      data-overlay="true"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1100,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--color-surface-container)", borderRadius: 16, padding: 20,
          display: "flex", flexDirection: "column", gap: 14, alignItems: "center",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-on-surface)", alignSelf: "flex-start" }}>
          {t("cropper.title")}
        </div>

        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          style={{
            position: "relative", width: VIEW, height: VIEW, overflow: "hidden",
            borderRadius: round ? "50%" : 12, cursor: "grab", touchAction: "none",
            background: "var(--color-surface-container-high)",
            border: "2px solid var(--color-primary)",
          }}
        >
          <canvas ref={canvasRef} width={VIEW} height={VIEW} style={{ display: "block", pointerEvents: "none" }} />
        </div>

        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(e) => {
            const z = Number(e.target.value);
            setZoom(z);
            setOffset((o) => clampOffset(o, baseScale * z));
          }}
          style={{ width: VIEW }}
        />
        <div style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>{t("cropper.hint")}</div>

        <div style={{ display: "flex", gap: 8, alignSelf: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 16px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 13,
              fontFamily: "inherit", background: "var(--color-surface-container-highest)", color: "var(--color-on-surface)",
            }}
          >{t("auth.cancel")}</button>
          <button
            type="button"
            onClick={confirm}
            disabled={!img || busy}
            style={{
              padding: "8px 16px", borderRadius: 10, border: "none", cursor: img && !busy ? "pointer" : "default",
              fontSize: 13, fontWeight: 600, fontFamily: "inherit",
              background: "var(--color-primary)", color: "var(--color-on-primary)", opacity: img && !busy ? 1 : 0.5,
            }}
          >{t("cropper.confirm")}</button>
        </div>
      </div>
    </div>
  );
}
