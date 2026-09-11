import {
  MatrixRTCSessionEvent,
  type MatrixRTCSession,
} from "matrix-js-sdk/lib/matrixrtc";
import type { CallMembershipIdentityParts } from "matrix-js-sdk/lib/matrixrtc/EncryptionManager";

/**
 * Pont entre les clés E2EE de MatrixRTCSession et le moteur LiveKit natif.
 *
 * Écoute les `EncryptionKeyChanged` de la session MatrixRTC et transfère
 * chaque clé brute au provider Rust (`voice_native_set_e2ee_key`). La classe
 * n'hérite plus du `BaseKeyProvider` de livekit-client : la webview ne
 * déchiffre plus aucun média.
 */
export class MatrixKeyProvider {
  private session: MatrixRTCSession | null = null;
  // Telemetry: first-key-per-peer measurement lets us spot to-device latency
  // issues after the fact without interactive debugging.
  private sessionAttachedAt = 0;
  private firstKeySeen = new Set<string>();
  // Pont E2EE natif : le moteur Rust ne voit pas les events MatrixRTC — on
  // lui transfère chaque clé (paires + la nôtre, que MatrixRTC réémet pour
  // chiffrer nos frames). Posé par useVoiceChannel sur salon chiffré.
  private nativeForwarder: ((identity: string, keyIndex: number, key: Uint8Array) => void) | null = null;
  // Anneau complet par identité (comme `participantKeyRings` côté MatrixRTC,
  // rejoué en entier par `reemitEncryptionKeys`) : le déchiffrement peut
  // exiger un ANCIEN index (émetteur en retard sur la rotation) — avec la
  // seule dernière clé, `MissingKey` définitif côté natif alors que le JS
  // (historique complet) entend. Borné à 16 par pair (fenêtre ratchet 10).
  private keyRings = new Map<string, Array<{ key: Uint8Array; keyIndex: number }>>();

  setRTCSession(session: MatrixRTCSession): void {
    this.disconnect();
    this.session = session;
    this.sessionAttachedAt = performance.now();
    this.firstKeySeen.clear();
    this.session.on(MatrixRTCSessionEvent.EncryptionKeyChanged, this.onEncryptionKey);
    console.log("[Sion][E2EE] MatrixKeyProvider attached to RTC session");

    // Re-emit existing keys so we pick up keys that arrived before we connected
    session.reemitEncryptionKeys();
  }

  disconnect(): void {
    if (this.session) {
      this.session.off(MatrixRTCSessionEvent.EncryptionKeyChanged, this.onEncryptionKey);
      this.session = null;
      this.firstKeySeen.clear();
      this.sessionAttachedAt = 0;
    }
    this.nativeForwarder = null;
    this.keyRings.clear();
  }

  /** Branche le transfert vers le moteur natif (useVoiceChannel, salon chiffré natif). */
  setNativeForwarder(
    cb: ((identity: string, keyIndex: number, key: Uint8Array) => void) | null,
  ): void {
    this.nativeForwarder = cb;
  }

  /** Rejoue tout l'historique connu vers le natif (après chaque connect),
   *  par index croissant (comme le reemit MatrixRTC). */
  flushKeysToNative(): number {
    if (!this.nativeForwarder) return 0;
    let n = 0;
    for (const [identity, ring] of this.keyRings) {
      const ordered = [...ring].sort((a, b) => a.keyIndex - b.keyIndex);
      for (const { key, keyIndex } of ordered) {
        try {
          this.nativeForwarder(identity, keyIndex, key);
          n++;
        } catch (err) {
          console.error(`[Sion][E2EE] flush natif vers ${identity}:`, err);
        }
      }
    }
    return n;
  }

  private onEncryptionKey = async (
    key: Uint8Array<ArrayBuffer>,
    encryptionKeyIndex: number,
    _membership: CallMembershipIdentityParts,
    rtcBackendIdentity: string,
  ): Promise<void> => {
    try {
      // Anneau borné (16) : remplace l'index déjà vu (re-reemit), sinon
      // ajoute en queue en éjectant le plus ancien.
      let ring = this.keyRings.get(rtcBackendIdentity);
      if (!ring) {
        ring = [];
        this.keyRings.set(rtcBackendIdentity, ring);
      }
      const known = ring.findIndex((e) => e.keyIndex === encryptionKeyIndex);
      const entry = { key: key.slice(), keyIndex: encryptionKeyIndex };
      if (known >= 0) ring[known] = entry;
      else {
        ring.push(entry);
        while (ring.length > 16) ring.shift();
      }
      if (this.nativeForwarder) {
        try {
          this.nativeForwarder(rtcBackendIdentity, encryptionKeyIndex, key);
        } catch (err) {
          console.error(`[Sion][E2EE] transfert natif vers ${rtcBackendIdentity}:`, err);
        }
      }

      // Structured log: first key per peer with elapsed time since attach.
      // Subsequent rotations are noisy and unhelpful in logs, so skip them.
      if (!this.firstKeySeen.has(rtcBackendIdentity)) {
        this.firstKeySeen.add(rtcBackendIdentity);
        const elapsed = this.sessionAttachedAt
          ? Math.round(performance.now() - this.sessionAttachedAt)
          : -1;
        console.log(
          `[Sion][E2EE] imported first key from ${rtcBackendIdentity} index=${encryptionKeyIndex} elapsed=${elapsed}ms`,
        );
      }
    } catch (err) {
      console.error(`[Sion][E2EE] Failed to import key from ${rtcBackendIdentity}:`, err);
    }
  };
}
