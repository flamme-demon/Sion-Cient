import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectNativeSession, disconnectNativeSession } from "./nativeVoiceSession";
import { useLiveKitStore } from "../stores/useLiveKitStore";
import type { VoiceNativeStatus } from "./voiceNativeService";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(), disconnect: vi.fn(), status: vi.fn(), participants: vi.fn(), data: vi.fn(), e2ee: vi.fn(), shareFailed: vi.fn(),
}));
vi.mock("./voiceNativeService", () => ({
  voiceNativeConnect: mocks.connect, voiceNativeDisconnect: mocks.disconnect,
  onVoiceNativeStatus: mocks.status, onVoiceNativeParticipants: mocks.participants,
  onVoiceNativeData: mocks.data, onVoiceNativeE2eeState: mocks.e2ee,
  onVoiceNativeLocalShareFailed: mocks.shareFailed,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const status: VoiceNativeStatus = {
  state: "connected", room_name: "room", identity: "me", muted: false, deafened: false, mic_published: true,
};
function options() {
  return {
    url: "wss://test", token: "token", room: "room", displayName: "Me", encrypted: true,
    devices: { inputDevice: "mic", outputDevice: "speaker" },
    processing: { echoCancellation: true, autoGainControl: false, noiseSuppression: true, mix: 0.5 },
    audioQuality: "voiceHD" as const,
    onParticipants: vi.fn(), onData: vi.fn(), onE2ee: vi.fn(), onLocalScreenShareFailed: vi.fn(), onClosed: vi.fn(),
    onDisconnected: vi.fn().mockResolvedValue(undefined),
  };
}
let unlisten: ReturnType<typeof vi.fn>[];
beforeEach(() => {
  vi.clearAllMocks();
  useLiveKitStore.getState().disconnect();
  unlisten = [];
  for (const listener of [mocks.status, mocks.participants, mocks.data, mocks.e2ee, mocks.shareFailed]) {
    listener.mockImplementation(async () => {
      const stop = vi.fn(); unlisten.push(stop); return stop;
    });
  }
  mocks.connect.mockResolvedValue(status);
  mocks.disconnect.mockResolvedValue({ ...status, state: "disconnected" });
});
afterEach(async () => { await disconnectNativeSession(); });

describe("native session lifecycle", () => {
  it("subscribes before connecting and receives participants emitted during connect", async () => {
    const opts = options();
    const participants = [{ identity: "already-present" }];
    mocks.connect.mockImplementation(async () => {
      expect(unlisten).toHaveLength(5);
      mocks.participants.mock.calls[0][0](participants);
      return status;
    });
    await connectNativeSession(opts);
    expect(opts.onParticipants).toHaveBeenCalledWith(participants, expect.any(Function));
    expect(mocks.connect).toHaveBeenCalledWith(
      "wss://test", "token", "room", "Me", true, opts.devices, opts.processing, opts.audioQuality,
    );
    expect(useLiveKitStore.getState().connected).toBe(true);
  });

  it("updates reconnecting/reconnected and fully cleans up a terminal disconnect", async () => {
    const opts = options();
    await connectNativeSession(opts);
    const event = mocks.status.mock.calls[0][0];
    event({ ...status, state: "reconnecting" });
    expect(useLiveKitStore.getState().connectionState).toBe("reconnecting");
    event(status);
    expect(useLiveKitStore.getState().connectionState).toBe("connected");
    event({ ...status, state: "disconnected" });
    await disconnectNativeSession();
    expect(opts.onDisconnected).toHaveBeenCalledOnce();
    expect(opts.onClosed).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(useLiveKitStore.getState().connected).toBe(false);
    unlisten.forEach((stop) => expect(stop).toHaveBeenCalledOnce());
  });

  it("relays a local screen capture failure only to the active session", async () => {
    const first = options();
    await connectNativeSession(first);
    const oldFailure = mocks.shareFailed.mock.calls[0][0];
    oldFailure({ reason: "portail fermé" });
    expect(first.onLocalScreenShareFailed).toHaveBeenCalledWith("portail fermé");

    await connectNativeSession(options());
    oldFailure({ reason: "ancienne session" });
    expect(first.onLocalScreenShareFailed).toHaveBeenCalledOnce();
  });

  it("removes subscriptions and closes a partially opened room on connect failure", async () => {
    mocks.connect.mockRejectedValue(new Error("SFU unavailable"));
    const opts = options();
    await expect(connectNativeSession(opts)).rejects.toThrow("SFU unavailable");
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(opts.onDisconnected).not.toHaveBeenCalled();
    unlisten.forEach((stop) => expect(stop).toHaveBeenCalledOnce());
    expect(useLiveKitStore.getState().connected).toBe(false);
  });

  it("does not open a room when listener registration fails", async () => {
    mocks.data.mockRejectedValue(new Error("IPC unavailable"));
    await expect(connectNativeSession(options())).rejects.toThrow("IPC unavailable");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    unlisten.forEach((stop) => expect(stop).toHaveBeenCalledOnce());
  });

  it("waits for an in-flight connect before disconnecting its room", async () => {
    const pending = deferred<VoiceNativeStatus>();
    mocks.connect.mockReturnValue(pending.promise);
    const joining = connectNativeSession(options());
    const failedJoin = expect(joining).rejects.toThrow("interrompue");
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
    const leaving = disconnectNativeSession();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    pending.resolve(status);
    await leaving;
    await failedJoin;
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(useLiveKitStore.getState().connected).toBe(false);
  });

  it("unsubscribes a listener whose registration finishes after leave", async () => {
    const pending = deferred<() => void>();
    const lateStop = vi.fn();
    mocks.participants.mockReturnValue(pending.promise);
    const joining = connectNativeSession(options());
    const failedJoin = expect(joining).rejects.toThrow("annulée");
    await vi.waitFor(() => expect(mocks.participants).toHaveBeenCalledOnce());
    const leaving = disconnectNativeSession();
    pending.resolve(lateStop);
    await leaving;
    await failedJoin;
    expect(lateStop).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("ignores callbacks and async work from the previous session after rejoin", async () => {
    const first = options();
    await connectNativeSession(first);
    const oldParticipants = mocks.participants.mock.calls[0][0];
    oldParticipants([]);
    const isCurrent = first.onParticipants.mock.calls[0][1];
    const second = options();
    await connectNativeSession(second);
    expect(isCurrent()).toBe(false);
    oldParticipants([{ identity: "stale" }]);
    mocks.status.mock.calls[0][0]({ ...status, state: "disconnected" });
    expect(first.onParticipants).toHaveBeenCalledOnce();
    expect(useLiveKitStore.getState().connected).toBe(true);
  });

  it("rejects a room lost before connect returns, without publishing connected state", async () => {
    mocks.connect.mockImplementation(async () => {
      mocks.status.mock.calls[0][0]({ ...status, state: "disconnected" });
      return status;
    });
    await expect(connectNativeSession(options())).rejects.toThrow("interrompue");
    expect(useLiveKitStore.getState().connected).toBe(false);
  });

  it("waits for membership cleanup before opening a replacement session", async () => {
    const cleanup = deferred<void>();
    const first = options();
    first.onDisconnected.mockReturnValue(cleanup.promise);
    await connectNativeSession(first);
    mocks.status.mock.calls[0][0]({ ...status, state: "disconnected" });
    await vi.waitFor(() => expect(first.onDisconnected).toHaveBeenCalledOnce());
    const next = connectNativeSession(options());
    expect(mocks.connect).toHaveBeenCalledOnce();
    cleanup.resolve();
    await next;
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(useLiveKitStore.getState().connected).toBe(true);
  });

  it("still closes the room if overlay cleanup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const opts = options();
      opts.onClosed.mockRejectedValue(new Error("overlay unavailable"));
      await connectNativeSession(opts);
      await disconnectNativeSession();
      expect(mocks.disconnect).toHaveBeenCalledOnce();
      expect(useLiveKitStore.getState().connected).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
