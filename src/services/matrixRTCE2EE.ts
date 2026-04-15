import { BaseKeyProvider } from "livekit-client";
import {
  MatrixRTCSessionEvent,
  type MatrixRTCSession,
} from "matrix-js-sdk/lib/matrixrtc";
import type { CallMembershipIdentityParts } from "matrix-js-sdk/lib/matrixrtc/EncryptionManager";

/**
 * Bridge between MatrixRTCSession encryption keys and LiveKit's E2EE KeyProvider.
 *
 * Listens for EncryptionKeyChanged events from the MatrixRTC session and
 * imports the raw keys as CryptoKeys for LiveKit's E2EE worker.
 */
export class MatrixKeyProvider extends BaseKeyProvider {
  private session: MatrixRTCSession | null = null;

  constructor() {
    // Align with Element Call's config: the ratchet window lets LiveKit's
    // decoder forward-ratchet up to 10 steps when the peer rotated their
    // key slightly before we received the new index — absorbs natural
    // drift without any application-level recovery. keyringSize caps how
    // many historical keys we keep per participant.
    super({ ratchetWindowSize: 10, keyringSize: 256 });
  }

  setRTCSession(session: MatrixRTCSession): void {
    this.disconnect();
    this.session = session;
    this.session.on(MatrixRTCSessionEvent.EncryptionKeyChanged, this.onEncryptionKey);

    // Re-emit existing keys so we pick up keys that arrived before we connected
    session.reemitEncryptionKeys();
  }

  disconnect(): void {
    if (this.session) {
      this.session.off(MatrixRTCSessionEvent.EncryptionKeyChanged, this.onEncryptionKey);
      this.session = null;
    }
  }

  private onEncryptionKey = async (
    key: Uint8Array<ArrayBuffer>,
    encryptionKeyIndex: number,
    _membership: CallMembershipIdentityParts,
    rtcBackendIdentity: string,
  ): Promise<void> => {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key,
        "HKDF",
        false,
        ["deriveBits", "deriveKey"],
      );
      this.onSetEncryptionKey(cryptoKey, rtcBackendIdentity, encryptionKeyIndex);
    } catch (err) {
      console.error("[Sion] Failed to import E2EE key:", err);
    }
  };
}
