import { useEffect, useState } from "react";
import { HashIcon, AdminRoomIcon } from "../icons";
import type { Channel } from "../../types/matrix";
import { findAdminRoom } from "../../services/adminCommandService";
import { getAvatarUrl } from "../../services/matrixService";
import { useMatrixStore } from "../../stores/useMatrixStore";

interface ChannelIconProps {
  channel?: Channel;
  /** Barre réduite : l'icône y est seule, sans le nom à côté. */
  compact?: boolean;
}

/** Avatar des interlocuteurs de MP : une requête par personne, gardée
 *  dix minutes. */
const AVATAR_VALIDE_MS = 10 * 60_000;
const avatars = new Map<string, { url: Promise<string | null>; date: number }>();

function avatarDe(utilisateur: string): Promise<string | null> {
  const connu = avatars.get(utilisateur);
  if (connu && Date.now() - connu.date < AVATAR_VALIDE_MS) return connu.url;
  const url = getAvatarUrl(utilisateur).catch(() => null);
  avatars.set(utilisateur, { url, date: Date.now() });
  return url;
}

function useAvatar(utilisateur: string | undefined): string | null {
  const [lu, setLu] = useState<{ pour: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!utilisateur) return;
    let actif = true;
    void avatarDe(utilisateur).then((url) => { if (actif) setLu({ pour: utilisateur, url }); });
    return () => { actif = false; };
  }, [utilisateur]);
  return lu && lu.pour === utilisateur ? lu.url : null;
}

/** Image, ou première lettre du nom (emoji compris). */
function Pastille({ url, nom, rond, taille }: { url?: string | null; nom: string; rond: boolean; taille: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: taille,
        height: taille,
        borderRadius: rond ? '50%' : 6,
        flexShrink: 0,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-surface-container-highest)',
        color: 'var(--color-on-surface)',
        fontSize: Math.round(taille * 0.5),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {url
        ? <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : (Array.from(nom.trim())[0] || '?').toUpperCase()}
    </span>
  );
}

/**
 * Icône d'un salon : son image s'il en a une ; sinon, pour un MP, l'avatar
 * de l'interlocuteur (ou son initiale) ; un bouclier pour le salon
 * d'administration ; l'initiale du nom en barre réduite, où le « # » seul
 * ne permettait pas de distinguer les salons ; « # » ailleurs.
 */
export function ChannelIcon({ channel, compact = false }: ChannelIconProps) {
  // Le salon d'administration n'est connu qu'une fois le cache du cœur
  // rempli : ce compteur change à chaque réponse qui y arrive.
  useMatrixStore((s) => s.pinnedVersion);
  const avatarMp = useAvatar(channel?.isDM && !channel.icon ? channel.dmUserId : undefined);
  const taille = compact ? 20 : 18;

  if (channel?.icon) {
    return (
      <img
        src={channel.icon}
        alt=""
        style={{
          width: taille,
          height: taille,
          borderRadius: 6,
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }
  if (channel?.isDM) return <Pastille url={avatarMp} nom={channel.name} rond taille={taille} />;
  if (channel && channel.id === findAdminRoom()) return <AdminRoomIcon className="text-text-muted flex-shrink-0" />;
  if (compact && channel?.name) return <Pastille nom={channel.name} rond={false} taille={taille} />;
  return <HashIcon className="text-text-muted flex-shrink-0" />;
}
