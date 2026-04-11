/**
 * CEF Audio Device Shim
 *
 * CEF's enumerateDevices() returns empty IDs/labels. This module overrides
 * the Web Audio APIs so that LiveKit (and any other WebRTC code) sees real
 * devices fetched from PulseAudio via the Tauri backend.
 *
 * - enumerateDevices() → returns PulseAudio devices with real names
 * - getUserMedia({ deviceId: "alsa_input..." }) → switches PulseAudio default,
 *   then calls the real getUserMedia without the deviceId constraint
 */

let shimInstalled = false;

function isNativeId(id: string | undefined): boolean {
  return !!id && (id.startsWith("alsa_") || id.includes("CARD="));
}

function extractDeviceId(constraint: unknown): string | undefined {
  if (!constraint || typeof constraint !== "object") return undefined;
  const c = constraint as Record<string, unknown>;
  if (typeof c.exact === "string") return c.exact;
  if (typeof c.ideal === "string") return c.ideal;
  return undefined;
}

export async function installCefAudioShim() {
  if (shimInstalled) return;
  if (!window.__TAURI_INTERNALS__) return;

  // Quick check: does the browser return real device IDs?
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasRealIds = devices.some(
      (d) => d.deviceId && d.deviceId !== "" && d.deviceId !== "default" && d.label !== "",
    );
    if (hasRealIds) return;
  } catch {
    return;
  }

  shimInstalled = true;
  const { invoke } = await import("@tauri-apps/api/core");

  // ── Override enumerateDevices ──────────────────────────────────────────
  const originalEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);

  navigator.mediaDevices.enumerateDevices = async (): Promise<MediaDeviceInfo[]> => {
    const webDevices = await originalEnumerate();

    let nativeAudio: { id: string; name: string; kind: string }[] = [];
    try {
      nativeAudio = await invoke<typeof nativeAudio>("list_audio_devices");
    } catch {
      return webDevices;
    }

    const nonAudio = webDevices.filter(
      (d) => d.kind !== "audioinput" && d.kind !== "audiooutput",
    );

    const nativeDevices: MediaDeviceInfo[] = nativeAudio.map((d) => ({
      deviceId: d.id,
      groupId: "",
      kind: (d.kind === "input" ? "audioinput" : "audiooutput") as MediaDeviceKind,
      label: d.name,
      toJSON() { return { deviceId: this.deviceId, groupId: this.groupId, kind: this.kind, label: this.label }; },
    }));

    return [...nonAudio, ...nativeDevices];
  };

  // ── Override getUserMedia ─────────────────────────────────────────────
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async (
    constraints?: MediaStreamConstraints,
  ): Promise<MediaStream> => {
    if (constraints?.audio && typeof constraints.audio === "object") {
      const audioConstraints = constraints.audio as MediaTrackConstraints;
      const requestedId = extractDeviceId(audioConstraints.deviceId) ||
        (typeof audioConstraints.deviceId === "string" ? audioConstraints.deviceId : undefined);

      if (requestedId && isNativeId(requestedId)) {
        let oldDefault: string | undefined;
        try {
          const defaults = await invoke<{ source_id: string }>("get_default_audio_devices");
          oldDefault = defaults.source_id;
        } catch { /* ignore */ }

        // Set PulseAudio default so Chrome negotiates the right audio format
        try {
          await invoke("set_default_audio", { deviceId: requestedId, kind: "input" });
        } catch { /* best-effort */ }

        const { deviceId: _stripped, ...restAudio } = audioConstraints;
        const stream = await originalGetUserMedia({
          ...constraints,
          audio: Object.keys(restAudio).length > 0 ? restAudio : true,
        });

        // Pin the stream to the target device after PipeWire registers it,
        // then restore the system default.
        setTimeout(async () => {
          try { await invoke("switch_audio_device", { deviceId: requestedId, kind: "input" }); } catch { /* not yet registered */ }

          if (oldDefault && oldDefault !== requestedId) {
            try { await invoke("set_default_audio", { deviceId: oldDefault, kind: "input" }); } catch { /* best-effort */ }
            await new Promise((r) => setTimeout(r, 300));
            try { await invoke("switch_audio_device", { deviceId: requestedId, kind: "input" }); } catch { /* best-effort */ }
          }
        }, 500);

        return stream;
      }
    }
    return originalGetUserMedia(constraints);
  };

  // ── Override setSinkId on HTMLMediaElement ─────────────────────────────
  const originalSetSinkId = HTMLMediaElement.prototype.setSinkId;
  if (originalSetSinkId) {
    HTMLMediaElement.prototype.setSinkId = async function (sinkId: string) {
      if (isNativeId(sinkId)) {
        try {
          await invoke("switch_audio_device", { deviceId: sinkId, kind: "output" });
        } catch { /* best-effort */ }
        return originalSetSinkId.call(this, "");
      }
      return originalSetSinkId.call(this, sinkId);
    };
  }
}
