/**
 * Événements propres à Sion reçus dans le fil d'un salon — éjection du vocal
 * (`com.sion.voice_kick`), transcription de réunion (`com.sion.transcript`,
 * `com.sion.transcript.session`) —, traités de la même façon par les deux
 * moteurs Matrix.
 *
 * Le moteur Rust les relayait (`matrix-evenement-sion`) mais personne ne les
 * écoutait : en 2.0, une éjection du vocal restait sans effet (Narkow, 01/10)
 * et la transcription en direct ne recevait rien des autres. Le moteur JS les
 * lit dans son fil (en clair, ou une fois déchiffrés), le moteur Rust les
 * reçoit du cœur ; tous deux passent ici.
 */
import { useAppStore } from "../stores/useAppStore";
import { playKickCue, playMemberKickedCue, noteKicked } from "./voiceChannelSounds";

export interface EvenementSionRecu {
  salon: string;
  type: string;
  sender: string;
  ts: number;
  content: Record<string, unknown> | null | undefined;
  /** Identifiant de l'événement, s'il est connu. */
  id?: string;
}

/** Ce que chaque moteur sait de la session et des membres. */
export interface ContexteSion {
  /** Notre identifiant Matrix. */
  moi: () => string | null;
  /** Niveau de pouvoir d'un membre du salon. */
  niveau: (salon: string, utilisateur: string) => number | Promise<number>;
  /** Nom affiché d'un membre, s'il est connu. */
  nom: (salon: string, utilisateur: string) => string | undefined;
}

/** Une même éjection peut arriver deux fois (écho local puis événement
 *  déchiffré, sous deux identifiants) : on la traite une fois par personne
 *  visée dans cette fenêtre. */
const KICK_HANDLE_DEDUP_MS = 8000;
const recentlyHandledKicks = new Map<string, number>();

/** Au-delà, c'est un rejeu (synchro initiale, rechargement), pas une éjection. */
const EJECTION_PERIMEE_MS = 60_000;

export async function traiterEvenementSion(ev: EvenementSionRecu, ctx: ContexteSion): Promise<void> {
  switch (ev.type) {
    case "com.sion.voice_kick":
      return traiterEjection(ev, ctx);
    case "com.sion.transcript.session":
      return traiterSessionTranscription(ev);
    case "com.sion.transcript":
      return traiterSegmentTranscription(ev, ctx);
  }
}

async function traiterEjection(ev: EvenementSionRecu, ctx: ContexteSion): Promise<void> {
  if (Date.now() - ev.ts > EJECTION_PERIMEE_MS) return;
  const content = ev.content;
  const vise = typeof content?.kicked_user === "string" ? content.kicked_user : "";
  if (!vise) return;

  // Seul un modérateur (niveau ≥ 50) peut éjecter : vaut pour la personne
  // visée comme pour les témoins, pour qu'une éjection usurpée ne coupe ni
  // ne sonne rien.
  const niveau = await ctx.niveau(ev.salon, ev.sender);
  if (niveau < 50) {
    console.warn("[Sion] Ignoring voice kick from non-moderator:", ev.sender, "PL:", niveau);
    return;
  }

  // Dédoublonnage APRÈS le contrôle du niveau : avant, une éjection usurpée
  // marquait la personne comme traitée et neutralisait une vraie éjection
  // pendant la fenêtre.
  const now = Date.now();
  const last = recentlyHandledKicks.get(vise);
  if (last != null && now - last < KICK_HANDLE_DEDUP_MS) return;
  recentlyHandledKicks.set(vise, now);

  if (vise !== ctx.moi()) {
    // Quelqu'un d'autre est éjecté : les autres membres de cet appel
    // l'entendent — seulement si l'on est dans ce même salon vocal.
    if (useAppStore.getState().connectedVoiceChannel === ev.salon) {
      // Son départ LiveKit imminent ne doit pas sonner en plus.
      noteKicked(vise);
      playMemberKickedCue();
    }
    return;
  }

  // C'est nous qui sommes éjectés.
  playKickCue();
  const parQui = (typeof content?.kicked_by_name === "string" && content.kicked_by_name)
    || ctx.nom(ev.salon, ev.sender) || ev.sender;
  console.warn("[Sion] Voice kicked by:", parQui);

  // Départ complet : LiveKit et appartenance à l'appel.
  const salonQuitte = useAppStore.getState().connectedVoiceChannel;
  if (salonQuitte) {
    const { cleanupVoiceOnKick } = await import("../hooks/useVoiceChannel");
    void cleanupVoiceOnKick();
  }

  // Message persistant, avec le salon pour y revenir.
  const raison = typeof content?.reason === "string" && content.reason ? ` — ${content.reason}` : "";
  useAppStore.setState({ kickMessage: `Kick par ${parQui}${raison}`, kickedFromRoom: salonQuitte || ev.salon });
}

async function traiterSessionTranscription(ev: EvenementSionRecu): Promise<void> {
  // Début (identifiant et date) ou fin collective d'une session : le service
  // décide de l'adoption et de la réaction du moteur.
  const c = ev.content;
  if ((c?.action !== "start" && c?.action !== "end") || typeof c?.id !== "string") return;
  const { handleSessionEvent } = await import("./transcriptionService");
  handleSessionEvent(ev.salon, c.action, c.id, typeof c.ts === "number" ? c.ts : ev.ts, ev.sender);
}

async function traiterSegmentTranscription(ev: EvenementSionRecu, ctx: ContexteSion): Promise<void> {
  const c = ev.content;
  const text = c?.text;
  if (typeof text !== "string" || !text) return;
  const senderName = ctx.nom(ev.salon, ev.sender) || ev.sender.replace(/^@/, "").split(":")[0];
  const { useTranscriptStore } = await import("../stores/useTranscriptStore");
  // Le magasin dédoublonne par contenu : un segment reçu deux fois (écho
  // local puis serveur, ou déchiffrement rejoué) ne s'affiche qu'une fois.
  useTranscriptStore.getState().addEntry({
    id: ev.id || `${ev.salon}:${ev.ts}`,
    roomId: ev.salon,
    senderId: ev.sender,
    senderName,
    text,
    t0: typeof c?.t0 === "number" ? c.t0 : ev.ts,
    t1: typeof c?.t1 === "number" ? c.t1 : 0,
    ...(typeof c?.session === "string" ? { sessionId: c.session } : {}),
  });
}

/** Pour les tests : oublie les éjections déjà traitées. */
export function oublierEjections(): void {
  recentlyHandledKicks.clear();
}
