import { encodeMonoPcm16Wav } from "@t3tools/contracts";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceRecorderError,
  type VoiceRecorder,
  type VoiceRecorderStatus,
} from "@t3tools/client-runtime/voice-input";

export const MAX_WAVEFORM_SAMPLES = 48;
const WAVEFORM_INTERVAL_MS = 80;
/** A working microphone delivers a non-zero sample well within this; longer silence is a blocked or muted input. */
const FIRST_AUDIO_SIGNAL_TIMEOUT_MS = 4_000;

const MICROPHONE_NO_INPUT_MESSAGE =
  "No sound is reaching T3 Code from the microphone. Check that the right input is selected and not muted, then try again.";

const MACOS_MICROPHONE_SETTINGS =
  "Turn on T3 Code in System Settings › Privacy & Security › Microphone, then try again. T3 Code may need to restart to notice the change.";

export interface VoiceRecorderSnapshot {
  readonly hasAudioSignal: boolean;
  readonly durationMs: number;
  readonly waveformLevels: readonly number[];
}

const IDLE: VoiceRecorderSnapshot = { hasAudioSignal: false, durationMs: 0, waveformLevels: [] };

export function formatVoiceRecordingDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

/** Maps a getUserMedia rejection to a message that says what to do next. */
export function toMicrophoneError(error: unknown, platform: string | null): unknown {
  const name = error instanceof Error ? error.name : undefined;
  if (name === "NotAllowedError" || name === "SecurityError") {
    if (platform === null)
      return new VoiceRecorderError(
        "The browser blocked the microphone. Allow microphone access for this site in the browser's site settings, then try again.",
      );
    return new VoiceRecorderError(
      platform === "darwin"
        ? `T3 Code could not use the microphone. ${MACOS_MICROPHONE_SETTINGS}`
        : "T3 Code could not use the microphone. Allow apps to use the microphone in your system's privacy settings, then try again.",
      platform === "darwin" ? "settings" : null,
    );
  }
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return new VoiceRecorderError("No microphone was found. Connect one and try again.", "retry");
  if (name === "NotReadableError" || name === "AbortError")
    return new VoiceRecorderError(
      "The microphone could not be started. Another app may be using it.",
      "retry",
    );
  return error;
}

interface Capture {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  readonly processor: ScriptProcessorNode;
  readonly gain: GainNode;
  readonly chunks: Float32Array[];
  sampleCount: number;
  hasAudioSignal: boolean;
  recording: boolean;
  lastWaveformAt: number;
  signalDeadline: ReturnType<typeof setTimeout> | null;
}

/**
 * Records mono audio and hands the shared voice controller a WAV blob URL when it stops.
 * The controller drives phases; this class only captures, meters and reports interruptions.
 */
export class BrowserVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  onStatus: ((status: VoiceRecorderStatus) => void) | null = null;
  private capture: Capture | null = null;
  private generation = 0;
  private snapshot = IDLE;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(snapshot: VoiceRecorderSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  async prepareToRecordAsync(signal?: AbortSignal): Promise<void> {
    await this.release();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new VoiceRecorderError(
        "Microphone recording needs a secure connection. Open T3 Code over HTTPS or on localhost in a supported browser.",
      );
    }
    const generation = ++this.generation;
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      throw toMicrophoneError(error, window.desktopBridge?.getClientPlatform?.() ?? null);
    }
    if (signal?.aborted || generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      throw new VoiceRecorderError("Voice recording was cancelled.");
    }
    const context = new AudioContext({ latencyHint: "interactive" });
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2_048, 1, 1);
    const gain = context.createGain();
    gain.gain.value = 0;
    const capture: Capture = {
      stream,
      context,
      source,
      processor,
      gain,
      chunks: [],
      sampleCount: 0,
      hasAudioSignal: false,
      recording: false,
      lastWaveformAt: -Infinity,
      signalDeadline: null,
    };
    processor.onaudioprocess = (event) => this.onAudio(capture, event.inputBuffer);
    source.connect(processor);
    processor.connect(gain);
    gain.connect(context.destination);
    this.capture = capture;
    this.publish(IDLE);
  }

  record(): void {
    const capture = this.capture;
    if (!capture) return;
    capture.recording = true;
    capture.signalDeadline = setTimeout(() => {
      capture.signalDeadline = null;
      if (this.capture !== capture || capture.hasAudioSignal) return;
      void this.release().then(() =>
        this.onStatus?.({
          isFinished: false,
          hasError: true,
          error: MICROPHONE_NO_INPUT_MESSAGE,
          url: null,
        }),
      );
    }, FIRST_AUDIO_SIGNAL_TIMEOUT_MS);
  }

  private onAudio(capture: Capture, buffer: AudioBuffer) {
    if (this.capture !== capture || !capture.recording) return;
    const limit = Math.round(capture.context.sampleRate * VOICE_RECORDING_LIMIT_SECONDS);
    const mono = new Float32Array(Math.min(buffer.length, limit - capture.sampleCount));
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < mono.length; i++) {
        mono[i] = (mono[i] ?? 0) + (samples[i] ?? 0) / buffer.numberOfChannels;
      }
    }
    let sum = 0;
    for (const sample of mono) sum += sample * sample;
    // Cold microphones produce exact zeroes; keep quiet real input and all later silence.
    if (!capture.hasAudioSignal && sum === 0) return;
    if (capture.signalDeadline !== null) clearTimeout(capture.signalDeadline);
    capture.signalDeadline = null;
    capture.hasAudioSignal = true;
    capture.chunks.push(mono);
    capture.sampleCount += mono.length;
    const now = performance.now();
    if (now - capture.lastWaveformAt >= WAVEFORM_INTERVAL_MS) {
      capture.lastWaveformAt = now;
      this.publish({
        hasAudioSignal: true,
        durationMs: (capture.sampleCount / capture.context.sampleRate) * 1_000,
        waveformLevels: [
          ...this.snapshot.waveformLevels,
          Math.min(1, Math.sqrt(sum / Math.max(1, mono.length)) * 3.2),
        ].slice(-MAX_WAVEFORM_SAMPLES),
      });
    }
    if (capture.sampleCount >= limit) {
      capture.recording = false;
      queueMicrotask(() => {
        if (this.capture !== capture) return;
        void this.stop().then(() =>
          this.onStatus?.({ isFinished: true, hasError: false, error: null, url: this.uri }),
        );
      });
    }
  }

  private async release(): Promise<Capture | null> {
    ++this.generation;
    const capture = this.capture;
    this.capture = null;
    if (!capture) return null;
    if (capture.signalDeadline !== null) clearTimeout(capture.signalDeadline);
    capture.signalDeadline = null;
    for (const track of capture.stream.getTracks()) track.stop();
    capture.processor.onaudioprocess = null;
    capture.source.disconnect();
    capture.processor.disconnect();
    capture.gain.disconnect();
    await capture.context.close().catch(() => undefined);
    return capture;
  }

  /** Idempotent: the first call encodes what was captured; later calls do nothing. */
  async stop(): Promise<void> {
    const capture = await this.release();
    if (!capture) return;
    const encoded = encodeMonoPcm16Wav(capture.chunks, capture.context.sampleRate);
    if (encoded) {
      this.uri = URL.createObjectURL(
        new Blob([new Uint8Array(encoded.bytes)], { type: "audio/wav" }),
      );
    }
  }

  /** Drops the capture without encoding it. */
  discard(): Promise<void> {
    if (this.capture) this.capture.chunks.length = 0;
    return this.release().then(() => undefined);
  }

  deleteRecording(uri: string): void {
    URL.revokeObjectURL(uri);
    if (this.uri === uri) this.uri = null;
  }
}
