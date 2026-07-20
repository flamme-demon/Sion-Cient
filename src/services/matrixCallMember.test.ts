/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildCallMemberContent,
  sendCallMemberEvent,
  removeCallMemberEvent,
  getLocalVoiceState,
  publishLocalVoiceState,
  republishCallMember,
  __setMatrixClientForTest,
} from "./matrixService";

const ROOM = "!voice:hs";

// sendCallMemberEvent guards against use before login — a minimal fake
// client satisfies that check. Every write it triggers (writeCallMember)
// targets sendStateEvent, which we don't assert on here (that's covered by
// buildCallMemberContent's content-shape tests below).
const fakeClient = {
  getUserId: () => "@greg:hs",
  getDeviceId: () => "dev1",
  sendStateEvent: vi.fn().mockResolvedValue({ event_id: "$x" }),
} as unknown as Parameters<typeof __setMatrixClientForTest>[0];

beforeEach(() => {
  __setMatrixClientForTest(fakeClient);
  removeCallMemberEvent(ROOM);
  vi.useRealTimers();
});

describe("buildCallMemberContent", () => {
  it("uses a membershipID matching the SDK's own format (userId:deviceId)", () => {
    // Regression for the v1.3.4 one-way-audio bug: our fast-path write and
    // the SDK's scheduled MembershipManager renewals must produce the SAME
    // membershipID, or peers see the membership churn (a "new" member each
    // time) and MatrixRTC key distribution breaks.
    const content = buildCallMemberContent("wss://lk.test", "alias1", "DEVICE1", "@greg:hs");
    expect(content.membershipID).toBe("@greg:hs:DEVICE1");
  });

  it("carries the Sion cross-channel mute/deafen fields from local state", () => {
    publishLocalVoiceState({ muted: true, deafened: false });
    const content = buildCallMemberContent("wss://lk.test", "alias1", "dev1", "@greg:hs");
    expect(content.sion_muted).toBe(true);
    expect(content.sion_deafened).toBe(false);
  });

  it("has a fixed 1h expiry horizon matching the SDK default", () => {
    const content = buildCallMemberContent("wss://lk.test", "alias1", "dev1", "@greg:hs");
    expect(content.expires).toBe(3_600_000);
  });
});

describe("call.member room cache", () => {
  it("sendCallMemberEvent registers the room — republishCallMember counts it", async () => {
    sendCallMemberEvent(ROOM, "wss://lk.test", "alias1");
    expect(await republishCallMember()).toBe(1);
  });

  it("removeCallMemberEvent clears the room from the cache", async () => {
    sendCallMemberEvent(ROOM, "wss://lk.test", "alias1");
    removeCallMemberEvent(ROOM);
    expect(await republishCallMember()).toBe(0);
  });

  it("removeCallMemberEvent resets the local mute/deafen snapshot", () => {
    publishLocalVoiceState({ muted: true, deafened: true });
    removeCallMemberEvent(ROOM);
    expect(getLocalVoiceState()).toEqual({ muted: false, deafened: false });
  });
});

describe("publishLocalVoiceState", () => {
  it("updates the local snapshot only for changed fields", () => {
    publishLocalVoiceState({ muted: true });
    expect(getLocalVoiceState()).toEqual({ muted: true, deafened: false });
    publishLocalVoiceState({ deafened: true });
    expect(getLocalVoiceState()).toEqual({ muted: true, deafened: true });
  });

  it("is idempotent — republishing the same state doesn't throw or change it", () => {
    publishLocalVoiceState({ muted: true });
    expect(() => publishLocalVoiceState({ muted: true })).not.toThrow();
    expect(getLocalVoiceState()).toEqual({ muted: true, deafened: false });
  });
});
