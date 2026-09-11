import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMutedSpeakDetection } from "./useMutedSpeakDetection";
import { useAppStore } from "../stores/useAppStore";
import { useSettingsStore } from "../stores/useSettingsStore";

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
});

const native = vi.hoisted(() => ({
  active: vi.fn(), level: vi.fn(), start: vi.fn(), stop: vi.fn(),
}));

vi.mock("../services/voiceNativeService", () => ({
  getActiveVoiceEngine: native.active,
  getVoiceNativeAudioLevel: native.level,
  startVoiceNativeMicrophoneTest: native.start,
  stopVoiceNativeAudioTest: native.stop,
}));

function Harness({ onSpeak }: { onSpeak: () => void }) {
  useMutedSpeakDetection(onSpeak);
  return null;
}

let root: Root;
let container: HTMLDivElement;
const getUserMedia = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T08:00:00Z"));
  vi.clearAllMocks();
  native.active.mockReturnValue("native");
  native.start.mockResolvedValue(undefined);
  native.stop.mockResolvedValue(undefined);
  let sequence = 0;
  native.level.mockImplementation(async () => ({ sequence: ++sequence, rms: 0.04 }));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true, value: { getUserMedia },
  });
  useAppStore.setState({ isMuted: true, isDeafened: false, connectedVoiceChannel: "!voice" });
  useSettingsStore.setState({ mutedSpeakAlert: true, micThreshold: 0.015, nativeAudioInputDevice: "native-mic" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("utilise le RMS Rust pendant le mute sans ouvrir de capture webview", async () => {
  const onSpeak = vi.fn();
  await act(async () => { root.render(<Harness onSpeak={onSpeak} />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });

  expect(native.start).toHaveBeenCalledWith("native-mic", "muted-speak-alert");
  expect(native.level).toHaveBeenCalled();
  expect(onSpeak).toHaveBeenCalledOnce();
  expect(getUserMedia).not.toHaveBeenCalled();

  await act(async () => { useAppStore.setState({ isMuted: false }); });
  expect(native.stop).toHaveBeenCalledWith("muted-speak-alert");
});
