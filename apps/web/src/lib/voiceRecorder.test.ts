import { VoiceRecorderError } from "@t3tools/client-runtime/voice-input";
import { describe, expect, it } from "vite-plus/test";

import { formatVoiceRecordingDuration, toMicrophoneError } from "./voiceRecorder";

const named = (name: string) => Object.assign(new Error(name), { name });

describe("toMicrophoneError", () => {
  it.each([
    [null, "site settings", null],
    ["win32", "system's privacy settings", null],
    ["darwin", "System Settings", "settings"],
  ] as const)("explains a permission block on %s", (platform, wording, action) => {
    const error = toMicrophoneError(named("NotAllowedError"), platform);
    expect(error).toBeInstanceOf(VoiceRecorderError);
    expect((error as VoiceRecorderError).message).toContain(wording);
    expect((error as VoiceRecorderError).errorAction).toBe(action);
  });

  it.each([
    ["SecurityError", "system's privacy settings"],
    ["NotFoundError", "No microphone was found"],
    ["OverconstrainedError", "No microphone was found"],
    ["NotReadableError", "Another app may be using it"],
    ["AbortError", "Another app may be using it"],
  ])("maps %s to a readable message", (name, wording) => {
    expect((toMicrophoneError(named(name), "linux") as VoiceRecorderError).message).toContain(
      wording,
    );
  });

  it("passes unknown failures through for the generic message", () => {
    const failure = named("TypeError");
    expect(toMicrophoneError(failure, null)).toBe(failure);
    expect(toMicrophoneError("nope", null)).toBe("nope");
  });
});

describe("formatVoiceRecordingDuration", () => {
  it.each([
    [-5, "0:00"],
    [999, "0:00"],
    [65_000, "1:05"],
    [300_000, "5:00"],
  ])("formats %i ms as %s", (ms, label) => {
    expect(formatVoiceRecordingDuration(ms)).toBe(label);
  });
});
