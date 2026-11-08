import { describe, expect, it } from "vite-plus/test";

import {
  base64ToUint8Array,
  encodeMonoPcm16Wav,
  uint8ArrayToBase64,
  validateCanonicalVoiceWav,
} from "./voiceWav.ts";

const wav = () => encodeMonoPcm16Wav([new Float32Array(24_000).fill(0.5)], 24_000)!;

describe("canonical WAV encoding and validation", () => {
  it("encodes clamped PCM16 and round-trips through base64", () => {
    const encoded = encodeMonoPcm16Wav(
      [Float32Array.of(-2, -0.5), Float32Array.of(0.5, 2)],
      24_000,
    )!;
    const view = new DataView(encoded.bytes.buffer);
    expect([0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      -32768, -16384, 16384, 32767,
    ]);
    expect(validateCanonicalVoiceWav(encoded.bytes, encoded.durationMs).ok).toBe(true);
    expect(base64ToUint8Array(uint8ArrayToBase64(encoded.bytes))).toEqual(encoded.bytes);
  });

  it("interpolates across chunk boundaries identically to contiguous input", () => {
    const samples = Float32Array.of(0, 0.25, 0.5, 0.75, 1, 0.5, 0, -0.5);
    const split = encodeMonoPcm16Wav(
      [samples.slice(0, 2), samples.slice(2, 5), samples.slice(5)],
      44_100,
    )!;
    expect(split.bytes).toEqual(encodeMonoPcm16Wav([samples], 44_100)!.bytes);
  });

  it("resamples a browser-rate recording to 24 kHz with a matching duration", () => {
    const encoded = encodeMonoPcm16Wav([new Float32Array(48_000)], 48_000)!;
    expect(encoded.sampleRateHz).toBe(24_000);
    expect(encoded.sampleCount).toBe(24_000);
    expect(encoded.durationMs).toBe(1_000);
  });

  it("refuses empty or nonsensical input", () => {
    expect(encodeMonoPcm16Wav([], 24_000)).toBeNull();
    expect(encodeMonoPcm16Wav([new Float32Array(0)], 24_000)).toBeNull();
    expect(encodeMonoPcm16Wav([new Float32Array(4)], 0)).toBeNull();
    expect(encodeMonoPcm16Wav([new Float32Array(4)], 24_000, Number.NaN)).toBeNull();
  });

  it.each([
    ["magic", (v: DataView) => v.setUint32(0, 0)],
    ["format", (v: DataView) => v.setUint16(20, 3, true)],
    ["stereo", (v: DataView) => v.setUint16(22, 2, true)],
    ["sample rate", (v: DataView) => v.setUint32(24, 16_000, true)],
    ["byte rate", (v: DataView) => v.setUint32(28, 32_000, true)],
    ["block alignment", (v: DataView) => v.setUint16(32, 4, true)],
    ["bit depth", (v: DataView) => v.setUint16(34, 8, true)],
    ["odd data", (v: DataView) => v.setUint32(40, 47_999, true)],
    ["empty data", (v: DataView) => v.setUint32(40, 0, true)],
    ["riff size", (v: DataView) => v.setUint32(4, 36, true)],
  ] as const)("rejects an invalid %s", (_, mutate) => {
    const bytes = wav().bytes;
    mutate(new DataView(bytes.buffer));
    expect(validateCanonicalVoiceWav(bytes).ok).toBe(false);
  });

  it("rejects payloads that are too short or too long", () => {
    expect(validateCanonicalVoiceWav(new Uint8Array(44)).ok).toBe(false);
    expect(validateCanonicalVoiceWav(new Uint8Array(15 * 1024 * 1024 + 1)).ok).toBe(false);
  });

  it("allows at most 250 ms of declared duration error", () => {
    const bytes = wav().bytes;
    expect(validateCanonicalVoiceWav(bytes, 1_250).ok).toBe(true);
    expect(validateCanonicalVoiceWav(bytes, 1_251).ok).toBe(false);
    expect(validateCanonicalVoiceWav(bytes, Number.NaN).ok).toBe(false);
    expect(validateCanonicalVoiceWav(bytes, 300_001).ok).toBe(false);
  });

  it("rejects malformed base64", () => {
    expect(base64ToUint8Array("!!!!")).toBeNull();
    expect(base64ToUint8Array("")).toBeNull();
    expect(base64ToUint8Array("abc")).toBeNull();
    expect(base64ToUint8Array("====")).toBeNull();
  });
});
