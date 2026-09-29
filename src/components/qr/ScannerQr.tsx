import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import jsQR from "jsqr";
import { CloseIcon } from "../icons";

export interface QrLu {
  texte: string;
  octets: number[];
}

/** Côté de l'image analysée : jsQR décode en pur JS, une image plus grande
 *  ralentirait sans rien gagner (le QR occupe le centre de la vue). */
const COTE_ANALYSE = 640;
const INTERVALLE_MS = 120;

/**
 * Scanner de QR code : caméra arrière + décodage jsQR, en JavaScript pur —
 * aucun service Google (ni ML Kit, ni `BarcodeDetector`, absent de toute
 * façon du WebView Android). `onLu` rend `null` si le QR est accepté (le
 * scanner se ferme), sinon le message à afficher en continuant de scanner.
 */
export function ScannerQr({ titre, aide, onLu, onFermer }: {
  titre: string;
  aide?: string;
  onLu: (lu: QrLu) => string | null | Promise<string | null>;
  onFermer: () => void;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const onLuRef = useRef(onLu);
  const onFermerRef = useRef(onFermer);
  useEffect(() => {
    onLuRef.current = onLu;
    onFermerRef.current = onFermer;
  });

  useEffect(() => {
    let flux: MediaStream | null = null;
    let minuteur: ReturnType<typeof setTimeout> | undefined;
    let fini = false;
    // Le même QR refusé n'est pas re-signalé à chaque image.
    let dernierRefus = "";
    const toile = document.createElement("canvas");
    const contexte = toile.getContext("2d", { willReadFrequently: true });

    const analyser = async () => {
      if (fini) return;
      const video = videoRef.current;
      if (video && contexte && video.readyState >= 2 && video.videoWidth > 0) {
        const echelle = Math.min(1, COTE_ANALYSE / Math.max(video.videoWidth, video.videoHeight));
        const l = Math.round(video.videoWidth * echelle);
        const h = Math.round(video.videoHeight * echelle);
        toile.width = l;
        toile.height = h;
        contexte.drawImage(video, 0, 0, l, h);
        const code = jsQR(contexte.getImageData(0, 0, l, h).data, l, h, { inversionAttempts: "dontInvert" });
        if (code && code.data !== dernierRefus) {
          setOccupe(true);
          const refus = await Promise.resolve(onLuRef.current({ texte: code.data, octets: code.binaryData }))
            .catch((e: unknown) => String(e));
          if (fini) return;
          setOccupe(false);
          if (refus === null) {
            fini = true;
            onFermerRef.current();
            return;
          }
          dernierRefus = code.data;
          setMessage(refus);
        }
      }
      minuteur = setTimeout(() => void analyser(), INTERVALLE_MS);
    };

    navigator.mediaDevices?.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    }).then((f) => {
      if (fini) { f.getTracks().forEach((p) => p.stop()); return; }
      flux = f;
      const video = videoRef.current;
      if (video) {
        video.srcObject = f;
        void video.play().catch(() => {});
      }
      void analyser();
    }).catch((e: unknown) => {
      const nom = (e as { name?: string })?.name;
      setMessage(nom === "NotAllowedError" ? t("qr.cameraDenied") : t("qr.cameraError"));
    });

    return () => {
      fini = true;
      clearTimeout(minuteur);
      flux?.getTracks().forEach((p) => p.stop());
    };
  }, [t]);

  return createPortal(
    <div
      data-overlay
      style={{
        position: "fixed", inset: 0, zIndex: 10000, background: "#000", // theme-exempt : vue caméra
        display: "flex", flexDirection: "column",
      }}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />
      {/* Cadre de visée */}
      <div style={{
        position: "absolute", left: "50%", top: "50%", width: "min(70vw, 70vh, 320px)", aspectRatio: "1",
        transform: "translate(-50%, -50%)", borderRadius: 24,
        boxShadow: "0 0 0 100vmax rgba(0,0,0,0.45)", border: "3px solid rgba(255,255,255,0.9)",
      }} />
      <div style={{
        position: "relative", display: "flex", alignItems: "center", gap: 12,
        padding: "calc(env(safe-area-inset-top, 0px) + 16px) 16px 16px", color: "#fff", // theme-exempt : sur l'image
      }}>
        <span style={{ flex: 1, fontSize: 16, fontWeight: 600 }}>{titre}</span>
        <button
          onClick={onFermer}
          aria-label={t("auth.cancel")}
          style={{
            width: 40, height: 40, borderRadius: 20, border: "none", cursor: "pointer",
            background: "rgba(255,255,255,0.15)", color: "#fff", // theme-exempt : sur l'image
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <CloseIcon />
        </button>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{
        position: "relative", padding: "16px 20px calc(env(safe-area-inset-bottom, 0px) + 24px)",
        color: "#fff", textAlign: "center", fontSize: 14, lineHeight: 1.45, // theme-exempt : sur l'image
      }}>
        {message
          ? <div style={{ background: "rgba(179,38,30,0.85)", borderRadius: 12, padding: "10px 14px" }}>{message}</div>
          : occupe ? t("qr.reading") : aide}
      </div>
    </div>,
    document.body,
  );
}
