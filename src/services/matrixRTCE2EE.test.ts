/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { MatrixKeyProvider } from "./matrixRTCE2EE";

// Le handler privé est exercé via un accès ciblé : c'est le seul point
// d'entrée des clés (event MatrixRTC `EncryptionKeyChanged`).
async function feedKey(
  provider: MatrixKeyProvider,
  identity: string,
  keyIndex: number,
  byte = 0xa5,
): Promise<void> {
  await (provider as unknown as {
    onEncryptionKey: (
      key: Uint8Array,
      index: number,
      membership: unknown,
      rtcId: string,
    ) => Promise<void>;
  }).onEncryptionKey(new Uint8Array(32).fill(byte), keyIndex, {}, identity);
}

describe("MatrixKeyProvider (pont E2EE natif)", () => {
  it("transfère chaque clé au forwarder natif (pairs + propre)", async () => {
    const provider = new MatrixKeyProvider();
    const forwarded: Array<{ identity: string; keyIndex: number; len: number }> = [];
    provider.setNativeForwarder((identity, keyIndex, key) => {
      forwarded.push({ identity, keyIndex, len: key.length });
    });
    await feedKey(provider, "@alice:srv:DEV1", 0);
    await feedKey(provider, "@moi:srv:DEV9", 0, 0x5a);
    expect(forwarded).toEqual([
      { identity: "@alice:srv:DEV1", keyIndex: 0, len: 32 },
      { identity: "@moi:srv:DEV9", keyIndex: 0, len: 32 },
    ]);
    provider.disconnect();
  });

  it("flushKeysToNative rejoue le connu après connect (clés pré-connect)", async () => {
    const provider = new MatrixKeyProvider();
    // Clés arrivées AVANT la pose du forwarder (reemit au attach).
    await feedKey(provider, "@alice:srv:DEV1", 0);
    await feedKey(provider, "@bob:srv:DEV2", 4);
    expect(provider.flushKeysToNative()).toBe(0);
    const forwarded: string[] = [];
    provider.setNativeForwarder((identity) => {
      forwarded.push(identity);
    });
    expect(provider.flushKeysToNative()).toBe(2);
    expect(forwarded.sort()).toEqual(["@alice:srv:DEV1", "@bob:srv:DEV2"]);
    provider.disconnect();
  });

  it("une rotation conserve l'historique (flush rejoue les deux index)", async () => {
    const provider = new MatrixKeyProvider();
    await feedKey(provider, "@alice:srv:DEV1", 0);
    await feedKey(provider, "@alice:srv:DEV1", 1, 0x5a);
    const seen: number[] = [];
    provider.setNativeForwarder((_id, keyIndex) => {
      seen.push(keyIndex);
    });
    expect(provider.flushKeysToNative()).toBe(2);
    expect(seen).toEqual([0, 1]);
    provider.disconnect();
  });

  it("l'anneau est borné à 16 par pair (plus ancien éjecté)", async () => {
    const provider = new MatrixKeyProvider();
    for (let i = 0; i < 18; i++) {
      await feedKey(provider, "@alice:srv:DEV1", i, i);
    }
    const seen: number[] = [];
    provider.setNativeForwarder((_id, keyIndex) => {
      seen.push(keyIndex);
    });
    expect(provider.flushKeysToNative()).toBe(16);
    expect(seen[0]).toBe(2);
    expect(seen[seen.length - 1]).toBe(17);
    provider.disconnect();
  });

  it("disconnect coupe le forwarder et vide le cache", async () => {
    const provider = new MatrixKeyProvider();
    const forward = vi.fn();
    provider.setNativeForwarder(forward);
    await feedKey(provider, "@alice:srv:DEV1", 0);
    expect(forward).toHaveBeenCalledTimes(1);
    provider.disconnect();
    expect(provider.flushKeysToNative()).toBe(0);
  });
});
