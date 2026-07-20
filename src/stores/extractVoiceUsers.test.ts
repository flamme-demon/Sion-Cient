/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";

vi.mock("../services/matrixService", () => ({ mxcToHttp: vi.fn() }));
vi.mock("../services/soundService", () => ({ playMessageReceived: vi.fn() }));
vi.mock("../services/voiceChannelSounds", () => ({
  playPokeCue: vi.fn(), playKickCue: vi.fn(), playMemberKickedCue: vi.fn(), noteKicked: vi.fn(),
}));
vi.mock("../services/adminCommandService", () => ({ findAdminRoom: vi.fn() }));
vi.mock("../utils/messageCache", () => ({
  setCachedRoom: vi.fn(), appendCachedEventIds: vi.fn(), clearCache: vi.fn(),
}));
vi.mock("./useAppStore", () => ({ useAppStore: { getState: () => ({}), subscribe: vi.fn() } }));
vi.mock("./useSettingsStore", () => ({ useSettingsStore: { getState: () => ({}), subscribe: vi.fn() } }));

import { extractVoiceUsers } from "./useMatrixStore";

// extractVoiceUsers reads the real Date.now() internally to evaluate
// expiry — anchor NOW to it so "future"/"past" offsets are correct
// regardless of when this suite runs.
const NOW = Date.now();

/** Fake org.matrix.msc3401.call.member state event. */
function callMemberEvent(
  sender: string,
  content: Record<string, unknown>,
  over: Partial<{ ts: number; stateKey: string }> = {},
) {
  return {
    getContent: () => content,
    getStateKey: () => over.stateKey ?? `_${sender}_dev1_m.call`,
    getSender: () => sender,
    getTs: () => over.ts ?? NOW,
  };
}

function room(events: unknown[]) {
  return { currentState: { getStateEvents: () => events } };
}

describe("extractVoiceUsers", () => {
  it("liste un membre actif au nouveau format (MSC4143), sans expiry connue", () => {
    const users = extractVoiceUsers(
      room([callMemberEvent("@alice:hs", { application: "m.call", device_id: "dev1" })]),
      null,
    );
    expect(users).toEqual([{
      id: "@alice:hs", name: "alice", role: "user", avatarUrl: undefined,
      speaking: false, muted: false, deafened: false,
    }]);
  });

  it("exclut un membre nouveau-format expiré (expires_ts dans le passé)", () => {
    const users = extractVoiceUsers(
      room([callMemberEvent("@alice:hs", {
        application: "m.call", device_id: "dev1", expires_ts: NOW - 1000,
      }, { ts: NOW - 5000 })]),
      null,
    );
    expect(users).toHaveLength(0);
  });

  it("garde un membre nouveau-format dont expires_ts est dans le futur", () => {
    const users = extractVoiceUsers(
      room([callMemberEvent("@alice:hs", {
        application: "m.call", device_id: "dev1", expires_ts: NOW + 60_000,
      })]),
      null,
    );
    expect(users).toHaveLength(1);
  });

  it("calcule l'expiration relative (origin_server_ts + expires) au nouveau format", () => {
    const expired = extractVoiceUsers(
      room([callMemberEvent("@alice:hs", { application: "m.call", device_id: "dev1", expires: 1000 }, { ts: NOW - 5000 })]),
      null,
    );
    expect(expired).toHaveLength(0);

    const active = extractVoiceUsers(
      room([callMemberEvent("@bob:hs", { application: "m.call", device_id: "dev1", expires: 60_000 }, { ts: NOW - 1000 })]),
      null,
    );
    expect(active).toHaveLength(1);
  });

  it("gère l'ancien format memberships[] avec expires_ts par entrée", () => {
    const users = extractVoiceUsers(
      room([callMemberEvent("@alice:hs", {
        memberships: [{ expires_ts: NOW - 1000 }, { expires_ts: NOW + 60_000 }],
      })]),
      null,
    );
    // Au moins une entrée active suffit à garder le membre.
    expect(users).toHaveLength(1);
  });

  it("un content vide ({}) — départ — n'apparaît pas", () => {
    expect(extractVoiceUsers(room([callMemberEvent("@alice:hs", {})]), null)).toHaveLength(0);
  });

  it("dédoublonne un utilisateur multi-appareils (garde la première occurrence)", () => {
    const users = extractVoiceUsers(
      room([
        callMemberEvent("@alice:hs", { application: "m.call", device_id: "dev1" }, { stateKey: "_@alice:hs_dev1_m.call" }),
        callMemberEvent("@alice:hs", { application: "m.call", device_id: "dev2" }, { stateKey: "_@alice:hs_dev2_m.call" }),
      ]),
      null,
    );
    expect(users).toHaveLength(1);
  });

  it("expose le mute/deafen cross-canal embarqué par Sion (sion_muted/sion_deafened)", () => {
    const users = extractVoiceUsers(
      room([callMemberEvent("@alice:hs", {
        application: "m.call", device_id: "dev1", sion_muted: true, sion_deafened: true,
      })]),
      null,
    );
    expect(users[0]).toMatchObject({ muted: true, deafened: true });
  });

  it("un client non-Sion (champs sion_* absents) retombe sur muted/deafened=false", () => {
    const users = extractVoiceUsers(
      room([callMemberEvent("@alice:hs", { application: "m.call", device_id: "dev1" })]),
      null,
    );
    expect(users[0]).toMatchObject({ muted: false, deafened: false });
  });
});
