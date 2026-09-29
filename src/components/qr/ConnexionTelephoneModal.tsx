import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import * as core from "../../services/matrixCore";
import { texteConnexionQr } from "../../services/connexionQr";
import { useAuthStore } from "../../stores/useAuthStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { QrImage } from "./QrImage";

/** Nouvel appareil guetté toutes les… (le jeton ne dit pas quand il sert). */
const GUET_MS = 3000;

/**
 * « Connecter un téléphone » : le mot de passe confirmé, un QR code porte le
 * serveur et un jeton de connexion à usage unique (voir connexionQr.ts). Le
 * téléphone le scanne depuis son écran de connexion ; la vérification suit
 * dans la bannière habituelle, que cette fenêtre laisse alors apparaître.
 */
export function ConnexionTelephoneModal({ onFermer, onVerification }: {
  onFermer: () => void;
  /** La demande de vérification du téléphone est arrivée (bannière). */
  onVerification: () => void;
}) {
  const { t } = useTranslation();
  const credentials = useAuthStore((s) => s.credentials);
  const [motDePasse, setMotDePasse] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(false);
  const [qr, setQr] = useState<{ texte: string; expire: number } | null>(null);
  const [maintenant, setMaintenant] = useState(() => Date.now());
  const [connecte, setConnecte] = useState<string | null>(null);
  // Gardé le temps de la fenêtre, pour un nouveau QR sans le redemander.
  const motDePasseRef = useRef("");
  const appareilsAvant = useRef<Set<string> | null>(null);

  const generer = async (mdp: string) => {
    if (!credentials || !mdp) return;
    setChargement(true);
    setErreur(null);
    try {
      const avant = await core.appareils().catch(() => null);
      appareilsAvant.current = avant ? new Set(avant.devices.map((d) => d.device_id)) : null;
      const { jeton, expireMs } = await core.jetonConnexion(mdp);
      motDePasseRef.current = mdp;
      setMotDePasse("");
      setQr({
        texte: texteConnexionQr({ serveur: credentials.homeserverUrl, utilisateur: credentials.userId, jeton }),
        expire: Date.now() + expireMs,
      });
    } catch (e) {
      const texte = String(e);
      setErreur(/forbidden|password|mot de passe/i.test(texte) ? t("qr.wrongPassword") : t("qr.tokenError", { error: texte }));
    } finally {
      setChargement(false);
    }
  };

  const expire = qr !== null && maintenant >= qr.expire;

  // Compte à rebours, et guet du téléphone : un appareil apparu depuis le QR.
  useEffect(() => {
    if (!qr || connecte) return;
    const horloge = setInterval(() => setMaintenant(Date.now()), 1000);
    const guet = setInterval(() => {
      const avant = appareilsAvant.current;
      if (!avant) return;
      core.appareils().then(({ devices }) => {
        const nouveau = devices.find((d) => !avant.has(d.device_id));
        if (nouveau) setConnecte(nouveau.display_name || nouveau.device_id);
      }).catch(() => {});
    }, GUET_MS);
    return () => { clearInterval(horloge); clearInterval(guet); };
  }, [qr, connecte]);

  // Le téléphone connecté demande sa vérification (parfois avant que le guet
  // ne l'ait vu) : la bannière prend le relais.
  const etapeVerification = useMatrixStore((s) => s.verificationStep);
  const etapePrecedente = useRef(etapeVerification);
  useEffect(() => {
    const avant = etapePrecedente.current;
    etapePrecedente.current = etapeVerification;
    const demarre = etapeVerification === "waiting" || etapeVerification === "pret";
    if ((qr || connecte) && demarre && avant !== etapeVerification) onVerification();
  }, [qr, connecte, etapeVerification, onVerification]);

  useEffect(() => () => { motDePasseRef.current = ""; }, []);

  const reste = qr ? Math.max(0, Math.ceil((qr.expire - maintenant) / 1000)) : 0;

  return createPortal(
    <div
      data-overlay
      onMouseDown={(e) => { if (e.target === e.currentTarget) onFermer(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div style={{
        width: "100%", maxWidth: 380, borderRadius: 24, padding: 24,
        background: "var(--color-surface-container-low)", color: "var(--color-on-surface)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", gap: 14,
      }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{t("qr.connectPhoneTitle")}</div>

        {connecte ? (
          <>
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>{t("qr.phoneConnected", { name: connecte })}</div>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--color-on-surface-variant)" }}>{t("qr.phoneConnectedHint")}</div>
          </>
        ) : qr ? (
          <>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.6, color: "var(--color-on-surface-variant)" }}>
              <li>{t("qr.step1")}</li>
              <li>{t("qr.step2")}</li>
              <li>{t("qr.step3")}</li>
            </ol>
            <div style={{ position: "relative", alignSelf: "center" }}>
              <div style={{ filter: expire ? "blur(6px)" : undefined, opacity: expire ? 0.4 : 1 }}>
                <QrImage texte={qr.texte} taille={240} alt={t("qr.connectPhoneTitle")} />
              </div>
              {expire && (
                <button
                  onClick={() => void generer(motDePasseRef.current)}
                  disabled={chargement}
                  style={{ ...boutonPrincipal, position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "auto", padding: "10px 18px" }}
                >
                  {t("qr.newCode")}
                </button>
              )}
            </div>
            <div style={{ fontSize: 12, textAlign: "center", color: "var(--color-on-surface-variant)" }}>
              {expire ? t("qr.expired") : t("qr.validFor", { time: `${Math.floor(reste / 60)}:${String(reste % 60).padStart(2, "0")}` })}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--color-error)" }}>{t("qr.keepPrivate")}</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--color-on-surface-variant)" }}>{t("qr.passwordHint")}</div>
            <input
              type="password"
              value={motDePasse}
              onChange={(e) => setMotDePasse(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void generer(motDePasse); }}
              placeholder={t("auth.password")}
              autoFocus
              autoComplete="off"
              style={{
                width: "100%", padding: "12px 14px", border: "none", outline: "none", boxSizing: "border-box",
                borderRadius: "12px 12px 4px 4px", fontSize: 14, fontFamily: "inherit",
                color: "var(--color-on-surface)", background: "var(--color-surface-container-high)",
              }}
            />
            <button
              onClick={() => void generer(motDePasse)}
              disabled={chargement || !motDePasse}
              style={{ ...boutonPrincipal, opacity: chargement || !motDePasse ? 0.6 : 1 }}
            >
              {chargement ? t("qr.generating") : t("qr.showCode")}
            </button>
          </>
        )}

        {erreur && (
          <div style={{ fontSize: 12, padding: "8px 10px", borderRadius: 10, background: "var(--color-error-container)", color: "var(--color-on-error-container)" }}>
            {erreur}
          </div>
        )}

        <button onClick={onFermer} style={boutonSecondaire}>{connecte ? t("qr.close") : t("auth.cancel")}</button>
      </div>
    </div>,
    document.body,
  );
}

const boutonPrincipal: React.CSSProperties = {
  width: "100%", padding: "12px 0", border: "none", borderRadius: 24, cursor: "pointer",
  fontSize: 14, fontWeight: 600, fontFamily: "inherit",
  background: "var(--color-primary)", color: "var(--color-on-primary)",
};

const boutonSecondaire: React.CSSProperties = {
  width: "100%", padding: "10px 0", border: "1px solid var(--color-outline-variant)", borderRadius: 24,
  cursor: "pointer", fontSize: 13, fontFamily: "inherit",
  background: "transparent", color: "var(--color-on-surface)",
};
