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
  // Telemetry: first-key-per-peer measurement lets us spot to-device latency
  // issues after the fact without interactive debugging.
  private sessionAttachedAt = 0;
  private firstKeySeen = new Set<string>();

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
