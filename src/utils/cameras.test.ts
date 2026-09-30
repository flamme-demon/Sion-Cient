import { describe, expect, it } from "vitest";
import { ordreCameras } from "./cameras";

describe("ordreCameras", () => {
  it("met la caméra arrière principale en tête (Xiaomi 12 : pas la n° 5)", () => {
    const cameras = [
      { deviceId: "f1", label: "camera2 1, facing front" },
      { deviceId: "b5", label: "camera2 5, facing back" },
      { deviceId: "b0", label: "camera2 0, facing back" },
      { deviceId: "b2", label: "camera2 2, facing back" },
    ];
    expect(ordreCameras(cameras)).toEqual(["b0", "b2", "b5", "f1"]);
  });

  it("garde un ordre sensé sans libellés parlants", () => {
    expect(ordreCameras([{ deviceId: "a", label: "" }, { deviceId: "b", label: "Back Camera" }])).toEqual(["b", "a"]);
    expect(ordreCameras([])).toEqual([]);
  });
});
