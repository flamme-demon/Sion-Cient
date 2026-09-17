import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useTranscriptStore } from "../../stores/useTranscriptStore";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useVoiceChannel } from "../../hooks/useVoiceChannel";
import { useDockZone } from "../layout/dockZoneContext";
import { MicIcon, HeadphoneIcon, DisconnectIcon, SpeakerIcon } from "../icons";

/**
 * Bloc « connexion vocale » détaché dans la dock (option A) — la version
 * bandeau : une **barre horizontale** (état, salon, micro, son, transcription,
 * raccrocher) pensée pour la zone basse, là où la carte verticale du menu
 * prendrait toute la hauteur. Le mécanisme de déplacement est celui du store :
 * le bouton ↲ le renvoie dans le menu latéral.
 */
export function VoiceStatusPanel() {
  const { t } = useTranslation();
  const zone = useDockZone();
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const isMuted = useAppStore((s) => s.isMuted);
  const isDeafened = useAppStore((s) => s.isDeafened);
  const toggleMute = useAppStore((s) => s.toggleMute);
  const toggleDeafen = useAppStore((s) => s.toggleDeafen);
  const channels = useMatrixStore((s) => s.channels);
  const transcriptState = useTranscriptStore((s) => s.state);
  const transcriptInvites = useTranscriptStore((s) => s.armedPeers.length);
  const transcriptPanelOpen = useLayoutStore(
    (s) => s.dockZones.right.panels.includes("transcript") || s.dockZones.bottom.panels.includes("transcript"),
  );
  const { leaveVoiceChannel } = useVoiceChannel();

  const activeVoice = channels.find((c) => c.id === connectedVoice);
  if (!connectedVoice || !activeVoice) return null;

  const btn = (active: boolean, accent: boolean, label: string, icon: React.ReactNode, onClick: () => void, title: string) => (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        padding: '6px 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        background: active
          ? accent ? 'var(--color-secondary-container)' : 'var(--color-error-container)'
          : 'var(--color-surface-container-highest)',
        color: active
          ? accent ? 'var(--color-on-secondary-container)' : 'var(--color-error)'
          : 'var(--color-on-surface)',
      }}
    >{icon}{label}</button>
  );

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      // Le bandeau haut est une barre : peu de padding vertical, sinon la
      // hauteur passe dans les marges et non dans le contenu.
      padding: zone === "top" ? '10px 14px' : zone === "bottom" ? '14px 16px' : 14,
    }}>
      {/* État */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-green)', animation: 'pulse 2s infinite' }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-green)', whiteSpace: 'nowrap' }}>{t("voice.connected")}</span>
      </span>

      {/* Salon courant */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-on-surface-variant)', minWidth: 0 }}>
        <SpeakerIcon />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{activeVoice.name}</span>
      </span>

      <div style={{ flex: 1, minWidth: 8 }} />

      {/* Micro / son */}
      {btn(isMuted, false, t("controls.micro"), <MicIcon muted={isMuted} />, () => toggleMute(), isMuted ? t("controls.unmute") : t("controls.mute"))}
      {btn(isDeafened, false, t("controls.sound"), <HeadphoneIcon muted={isDeafened} />, toggleDeafen, isDeafened ? t("controls.undeafen") : t("controls.deafen"))}

      {/* Transcription (ouvre/ferme le panneau, ne démarre rien) */}
      {btn(
        transcriptPanelOpen || transcriptState === "on" || transcriptInvites > 0,
        true,
        t("transcript.pill", { defaultValue: "Transcription" }),
        null,
        () => useLayoutStore.getState().toggleDockPanel("transcript"),
        t("transcript.togglePanel", { defaultValue: "Transcription de la réunion" }),
      )}

      {/* Raccrocher — c'est un DÉPART du salon vocal, pas une fermeture de
          panneau : le libellé le dit, la croix seule se confondait. */}
      <button
        onClick={() => leaveVoiceChannel(connectedVoice)}
        title={t("voice.disconnect")}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
          padding: '6px 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
          background: 'var(--color-error-container)', color: 'var(--color-error)',
          fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        }}
      >
        <DisconnectIcon />
        {t("layout.hangUp", { defaultValue: "Raccrocher" })}
      </button>
    </div>
  );
}
