import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { NativeAudioSettings } from "./NativeAudioSettings";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useAppStore } from "../../stores/useAppStore";

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
});

const native = vi.hoisted(() => ({
  available: vi.fn(), devices: vi.fn(), switchDevice: vi.fn(), processing: vi.fn(), active: vi.fn(),
  startMicTest: vi.fn(), stopAudioTest: vi.fn(), audioLevel: vi.fn(), speakerTest: vi.fn(), quality: vi.fn(),
}));
vi.mock("../../services/voiceNativeService", () => ({
  isVoiceNativeAvailable: native.available, getVoiceNativeAudioDevices: native.devices,
  setVoiceNativeAudioProcessing: native.processing,
  switchVoiceNativeAudioDevice: native.switchDevice, getActiveVoiceEngine: native.active,
  startVoiceNativeMicrophoneTest: native.startMicTest, stopVoiceNativeAudioTest: native.stopAudioTest,
  getVoiceNativeAudioLevel: native.audioLevel, testVoiceNativeSpeaker: native.speakerTest,
  setVoiceNativeAudioQuality: native.quality,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  native.available.mockResolvedValue(true);
  native.devices.mockResolvedValue({
    recording: [{ id: "native-mic", name: "USB mic", index: 1 }],
    playout: [{ id: "native-speaker", name: "Headphones", index: 1 }],
  });
  native.switchDevice.mockResolvedValue(undefined);
  native.processing.mockResolvedValue(undefined);
  native.startMicTest.mockResolvedValue(undefined);
  native.stopAudioTest.mockResolvedValue(undefined);
  native.audioLevel.mockResolvedValue({ sequence: 1, rms: 0.02 });
  native.speakerTest.mockResolvedValue(undefined);
  native.quality.mockResolvedValue(undefined);
  native.active.mockReturnValue("native");
  useSettingsStore.setState({ nativeAudioInputDevice: "", nativeAudioOutputDevice: "", audioInputDevice: "browser-mic", echoCancellation: true, autoGainControl: true, aiNoiseSuppression: true, aiNoiseSuppressionMix: 1, audioQuality: "voiceHD", micThreshold: 0.015 });
  useAppStore.setState({ connectedVoiceChannel: "!voice:hs" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() { await act(async () => root.render(<NativeAudioSettings />)); }
async function select(index: number, value: string) {
  await act(async () => {
    const element = container.querySelectorAll("select")[index];
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("applique le GUID natif et mémorise le choix sans écraser le périphérique JS", async () => {
  await render();
  await select(0, "native-mic");
  expect(native.switchDevice).toHaveBeenCalledWith("input", "native-mic");
  expect(useSettingsStore.getState().nativeAudioInputDevice).toBe("native-mic");
  expect(useSettingsStore.getState().audioInputDevice).toBe("browser-mic");
  await select(1, "native-speaker");
  expect(native.switchDevice).toHaveBeenCalledWith("output", "native-speaker");
  await select(1, "");
  expect(native.switchDevice).toHaveBeenLastCalledWith("output", "");
});

it("conserve le choix précédent et affiche l'échec si le moteur refuse", async () => {
  native.switchDevice.mockRejectedValue(new Error("débranché"));
  await render();
  await select(0, "native-mic");
  expect(useSettingsStore.getState().nativeAudioInputDevice).toBe("");
  expect(container.querySelector("select")?.value).toBe("");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

it("mémorise le choix hors appel sans démarrer de capture", async () => {
  useAppStore.setState({ connectedVoiceChannel: null });
  await render();
  await select(0, "native-mic");
  expect(native.switchDevice).not.toHaveBeenCalled();
  expect(useSettingsStore.getState().nativeAudioInputDevice).toBe("native-mic");
});

it("désactive les sélecteurs quand la feature Rust n'est pas disponible", async () => {
  native.available.mockResolvedValue(false);
  await render();
  expect(native.devices).not.toHaveBeenCalled();
  expect(container.querySelector("select")?.disabled).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("settings.nativeAudioUnavailable");
});

it("actualise les périphériques sans dépendre des événements du navigateur", async () => {
  vi.useFakeTimers();
  try {
    await render();
    await select(0, "native-mic");
    native.devices.mockResolvedValue({ recording: [], playout: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(container.textContent).toContain("settings.nativeAudioDeviceMissing");
    expect(useSettingsStore.getState().nativeAudioInputDevice).toBe("native-mic");
    // Refreshing a list must not silently change the capture of a running call.
    expect(native.switchDevice).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("applique les traitements au natif pendant l'appel et conserve l'intensité RNNoise", async () => {
  await render();
  expect(container.querySelector("fieldset")).toBeNull();
  expect(container.querySelector(".sion-range")).not.toBeNull();
  const switches = container.querySelectorAll('button[aria-pressed]');
  await act(async () => { (switches[1] as HTMLButtonElement).click(); });
  expect(native.processing).toHaveBeenLastCalledWith({ echoCancellation: false, autoGainControl: true, noiseSuppression: true, mix: 1 });
  expect(useSettingsStore.getState().echoCancellation).toBe(false);
  await act(async () => { (switches[0] as HTMLButtonElement).click(); });
  expect(native.processing).toHaveBeenLastCalledWith({ echoCancellation: false, autoGainControl: true, noiseSuppression: false, mix: 1 });
  expect(useSettingsStore.getState().aiNoiseSuppression).toBe(false);
});

it("ne mémorise pas un traitement refusé par le moteur", async () => {
  native.processing.mockRejectedValue(new Error("session terminée"));
  await render();
  await act(async () => { (container.querySelectorAll('button[aria-pressed]')[2] as HTMLButtonElement).click(); });
  expect(useSettingsStore.getState().autoGainControl).toBe(true);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

it("applique une intensité partielle sans réouvrir le microphone", async () => {
  await render();
  await act(async () => {
    const slider = container.querySelector('.sion-range') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "35");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(native.processing).toHaveBeenLastCalledWith({ echoCancellation: true, autoGainControl: true, noiseSuppression: true, mix: 0.35 });
  expect(useSettingsStore.getState().aiNoiseSuppressionMix).toBe(0.35);
  expect(native.switchDevice).not.toHaveBeenCalled();
});

it("affiche le niveau du vrai APM et arrête la capture de test au démontage", async () => {
  vi.useFakeTimers();
  try {
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(native.startMicTest).toHaveBeenCalledWith("", "settings");
    expect((container.querySelector('[data-testid="native-mic-level"]') as HTMLElement).style.width).toBe("20%");
    await act(async () => root.unmount());
    expect(native.stopAudioTest).toHaveBeenCalledOnce();
    root = createRoot(container);
  } finally {
    vi.useRealTimers();
  }
});

it("teste la sortie choisie et applique le profil de qualité à chaud", async () => {
  await render();
  await select(1, "native-speaker");
  const speakerButton = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent === "settings.speakerTestStart")!;
  await act(async () => { speakerButton.click(); });
  expect(native.speakerTest).toHaveBeenCalledWith("native-speaker");

  await select(2, "musicStereo");
  expect(native.quality).toHaveBeenCalledWith("musicStereo");
  expect(useSettingsStore.getState().audioQuality).toBe("musicStereo");
});
