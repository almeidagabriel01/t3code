import { VoiceRecorderError } from "@t3tools/client-runtime/voice-input";
import { expect, it, vi } from "vite-plus/test";

import { BrowserVoiceRecorder } from "./voiceRecorder";

// One second makes the recording limit reachable in a test without waiting minutes.
vi.mock("@t3tools/client-runtime/voice-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/voice-input")>()),
  VOICE_RECORDING_LIMIT_SECONDS: 1,
}));

function stubTone() {
  vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(async () => {
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    oscillator.connect(destination);
    oscillator.start();
    return destination.stream;
  });
}

const blobSize = async (url: string) => (await (await fetch(url)).blob()).size;

it("finishes by itself at the recording limit and hands over the WAV", async () => {
  stubTone();
  const recorder = new BrowserVoiceRecorder();
  const statuses = vi.fn();
  recorder.onStatus = statuses;
  await recorder.prepareToRecordAsync();
  recorder.record();
  // Real audio frames must fill the second; there is no clock to advance.
  await vi.waitFor(
    () =>
      expect(statuses).toHaveBeenCalledWith(
        expect.objectContaining({ isFinished: true, hasError: false, url: expect.any(String) }),
      ),
    { timeout: 8_000 },
  );
  const url = recorder.uri!;
  expect(url).toMatch(/^blob:/);
  // 1 s of 24 kHz mono PCM16 plus the 44-byte header.
  expect(await blobSize(url)).toBe(48_044);
  expect(recorder.getSnapshot().durationMs).toBeGreaterThan(0);
  recorder.deleteRecording(url);
  expect(recorder.uri).toBeNull();
});

it("encodes once on stop and keeps nothing after discard", async () => {
  stubTone();
  const recorder = new BrowserVoiceRecorder();
  await recorder.prepareToRecordAsync();
  recorder.record();
  await vi.waitFor(() => expect(recorder.getSnapshot().hasAudioSignal).toBe(true));
  await recorder.stop();
  const url = recorder.uri;
  expect(url).toMatch(/^blob:/);
  await recorder.stop();
  expect(recorder.uri).toBe(url);
  recorder.deleteRecording(url!);

  await recorder.prepareToRecordAsync();
  recorder.record();
  await recorder.discard();
  await recorder.stop();
  expect(recorder.uri).toBeNull();
});

it("refuses to finish a capture a newer preparation replaced", async () => {
  stubTone();
  const recorder = new BrowserVoiceRecorder();
  const abort = new AbortController();
  const preparing = recorder.prepareToRecordAsync(abort.signal);
  abort.abort();
  await expect(preparing).rejects.toBeInstanceOf(VoiceRecorderError);
  expect(recorder.uri).toBeNull();
});
