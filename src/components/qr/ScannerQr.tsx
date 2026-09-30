import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import jsQR from "jsqr";
import { CloseIcon } from "../icons";
import { ordreCameras } from "../../utils/cameras";

export interface QrLu {
  texte: string;
  octets: number[];
}

/** Côté de l'image analysée : jsQR décode en pur JS, une image plus grande
 *  ralentirait sans rien gagner (le QR occupe le centre de la vue). */
const COTE_ANALYSE = 640;
const INTERVALLE_MS = 120;
/** Sans image passé ce délai, la caméra est muette : on essaie la suivante. */
const DELAI_IMAGE_MS = 4000;

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
  const [plusieurs, setPlusieurs] = useState(false);
  const changerRef = useRef<() => void>(() => {});
  const onLuRef = useRef(onLu);
  const onFermerRef = useRef(onFermer);
  useEffect(() => {
    onLuRef.current = onLu;
    onFermerRef.current = onFermer;
  });

  useEffect(() => {
    let flux: MediaStream | null = null;
    let minuteur: ReturnType<typeof setTimeout> | undefined;
    let garde: ReturnType<typeof setTimeout> | undefined;
    let fini = false;
    // Caméras dans l'ordre d'essai, celle en cours, essais automatiques faits.
    let ordre: string[] = [];
    let rang = 0;
    let essais = 0;
    // Le même QR refusé n'est pas re-signalé à chaque image.
    let dernierRefus = "";
    const toile = document.createElement("canvas");
    const contexte = toile.getContext("2d", { willReadFrequently: true });

    const erreurCamera = (e: unknown) => {
      if (fini) return;
      const nom = (e as { name?: string })?.name;
      setMessage(nom === "NotAllowedError" ? t("qr.cameraDenied") : t("qr.cameraError"));
    };

    const imageRecue = () => {
      const v = videoRef.current;
      return !!v && v.readyState >= 2 && v.videoWidth > 0 && v.currentTime > 0;
    };

    // Caméra muette : la suivante, une fois chacune au plus.
    const essayerSuivante = () => {
      if (fini) return;
      if (ordre.length > 1 && essais < ordre.length) {
        essais += 1;
        void suivante();
      } else {
        setMessage(t("qr.noCameraImage"));
      }
    };

    const brancher = async (deviceId?: string) => {
      clearTimeout(garde);
      flux?.getTracks().forEach((p) => p.stop());
      flux = null;
      // Sans caméra précise (première ouverture, pour l'autorisation et les
      // libellés) : celle par défaut. « Caméra arrière » ouvrait sur un
      // Xiaomi la n° 5, muette — et `getUserMedia` ne répondait JAMAIS.
      const demande = navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : true,
        audio: false,
      });
      // Une caméra précise a un délai (la première attend, elle, la réponse
      // à la demande d'autorisation).
      const f = deviceId
        ? await Promise.race([demande, new Promise<null>((r) => setTimeout(() => r(null), DELAI_IMAGE_MS))])
        : await demande;
      if (!f) {
        void demande.then((tard) => tard.getTracks().forEach((p) => p.stop())).catch(() => {});
        essayerSuivante();
        return;
      }
      if (fini) { f.getTracks().forEach((p) => p.stop()); return; }
      flux = f;
      const video = videoRef.current;
      if (video) {
        video.srcObject = f;
        void video.play().catch(() => {});
      }
      garde = setTimeout(() => { if (!imageRecue()) essayerSuivante(); }, DELAI_IMAGE_MS);
    };

    const suivante = async () => {
      if (ordre.length < 2) return;
      rang = (rang + 1) % ordre.length;
      setMessage(null);
      await brancher(ordre[rang]).catch(erreurCamera);
    };
    changerRef.current = () => { essais = 0; void suivante(); };

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

    // Lu par une fonction : `flux` change dans `brancher`, hors de portée du
    // suivi de types de TypeScript.
    const fluxOuvert = (): MediaStream | null => flux;

    const cameras = async () =>
      (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia indisponible");
      // Les libellés des caméras ne sont donnés qu'une fois la caméra
      // autorisée : sans eux, une première ouverture « caméra arrière ».
      let liste = await cameras();
      let actuelle: string | undefined;
      if (!liste.some((c) => c.label)) {
        await brancher();
        if (fini) return;
        actuelle = fluxOuvert()?.getVideoTracks()[0]?.getSettings().deviceId;
        liste = await cameras();
      }
      ordre = ordreCameras(liste);
      setPlusieurs(ordre.length > 1);
      // La principale en tête ; rouverte si ce n'est pas celle déjà ouverte.
      rang = 0;
      if (ordre.length > 0 && ordre[0] !== actuelle) await brancher(ordre[0]);
      else if (ordre.length === 0 && !fluxOuvert()) await brancher();
      void analyser();
    })().catch(erreurCamera);

    return () => {
      fini = true;
      clearTimeout(minuteur);
      clearTimeout(garde);
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
        {plusieurs && (
          <button
            onClick={() => changerRef.current()}
            style={{
              marginTop: 12, padding: "10px 18px", borderRadius: 20, border: "none", cursor: "pointer",
              background: "rgba(255,255,255,0.15)", color: "#fff", fontSize: 14, fontFamily: "inherit", // theme-exempt : sur l'image
            }}
          >
            {t("qr.switchCamera")}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
