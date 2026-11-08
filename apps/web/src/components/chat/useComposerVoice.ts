import { type EnvironmentId, type ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import {
  createRuntimeCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import {
  createRemoteVoiceTranscriber,
  resolveEnvironmentVoiceContext,
  type EnvironmentVoiceRequestContext,
} from "@t3tools/client-runtime/voice-input/remote";
import * as Effect from "effect/Effect";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

import { useStableCallback } from "../../hooks/useStableCallback";
import {
  BrowserVoiceRecorder,
  formatVoiceRecordingDuration,
  type VoiceRecorderSnapshot,
} from "../../lib/voiceRecorder";
import { useEnvironment } from "../../state/environments";

export interface ComposerVoiceOptions {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  /** Identifies the draft; a different owner cancels a recording in progress. */
  readonly ownerKey: string;
  readonly enabled: boolean;
  readonly readDraft: () => {
    readonly text: string;
    readonly selection: VoiceDraftSnapshot["selection"];
  };
  readonly commitDraft: (text: string, selection: VoiceDraftSnapshot["selection"]) => void;
  /** Observes draft edits made while transcription runs, so edit-then-undo still counts as stale. */
  readonly subscribeDraft: (listener: () => void) => () => void;
}

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

const readAudioBytes = async (uri: string, signal: AbortSignal) =>
  new Uint8Array(await (await fetch(uri, { signal })).arrayBuffer());

/** The desktop app asks macOS first; a browser's own prompt appears when recording starts. */
async function requestMicrophonePermission() {
  const access = await window.desktopBridge?.requestMicrophoneAccess?.();
  if (access === "denied") return { granted: false, canAskAgain: false };
  if (access === "restricted" || access === "unavailable")
    return { granted: false, canAskAgain: true };
  return { granted: true, canAskAgain: true };
}

export function useComposerVoice(options: ComposerVoiceOptions) {
  const environmentLabel = useEnvironment(options.environmentId)?.label ?? null;
  const latest = useStableCallback(() => options);
  const [session] = useState(() => {
    const recorder = new BrowserVoiceRecorder();
    let state = IDLE;
    let revision = 0;
    let lastText: string | null = null;
    let lastOwner: string | null = null;
    let committed = false;
    let owner: string | null = null;
    const listeners = new Set<() => void>();
    const readDraft = (): VoiceDraftSnapshot => {
      const current = latest();
      const draft = current.readDraft();
      if (draft.text !== lastText || current.ownerKey !== lastOwner) revision += 1;
      lastText = draft.text;
      lastOwner = current.ownerKey;
      return { ownerKey: current.ownerKey, ...draft, revision };
    };
    const controller = new VoiceInputController({
      recorder,
      getTranscriber: () => {
        const current = latest();
        return createRemoteVoiceTranscriber({
          locale: navigator.language || "en-US",
          resolveContext: () => resolveComposerVoiceContext(current.environmentId),
          readAudioBytes,
          providerInstanceId: current.providerInstanceId,
          threadId: current.threadId,
        });
      },
      requestPermission: requestMicrophonePermission,
      configureRecording: async () => undefined,
      releaseRecording: async () => undefined,
      deleteRecording: (uri) => recorder.deleteRecording(uri),
      readDraft,
      commitDraft: (text, selection) => {
        committed = true;
        flushSync(() => latest().commitDraft(text, selection));
      },
      onStateChange: (next) => {
        state = next;
        for (const listener of listeners) listener();
      },
    });
    recorder.onStatus = (status) => void controller.handleRecorderStatus(status);
    return {
      recorder,
      controller,
      readDraft,
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      /** Resolves true when the transcript reached the draft. */
      confirm: async () => {
        committed = false;
        await controller.stop();
        return committed;
      },
      cancel: () => {
        void recorder.discard();
        controller.cancel();
      },
      /** A different draft owner releases the microphone and cancels network work. */
      setOwner: (key: string) => {
        if (owner !== null && owner !== key) controller.ownerChanged();
        owner = key;
      },
    };
  });
  const { controller, recorder } = session;
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const audio: VoiceRecorderSnapshot = useSyncExternalStore(
    recorder.subscribe,
    recorder.getSnapshot,
    recorder.getSnapshot,
  );
  const active = voiceInputBlocksSubmission(state);
  const { subscribeDraft, ownerKey } = options;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Another draft or an unmounted composer must release the microphone and cancel network work.
  useLayoutEffect(() => session.setOwner(ownerKey), [session, ownerKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the microphone when this composer unmounts.
  useLayoutEffect(() => () => session.cancel(), [session]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe edits while voice is running so the controller can tell the draft changed.
  useLayoutEffect(
    () => (active ? subscribeDraft(() => void session.readDraft()) : undefined),
    [active, subscribeDraft, session],
  );

  return {
    state,
    isActive: active,
    isStarting: state.phase === "preparing",
    isTranscribing: state.phase === "transcribing",
    isWaitingForAudio: state.phase === "recording" && !audio.hasAudioSignal,
    waveformLevels: audio.waveformLevels,
    durationLabel: formatVoiceRecordingDuration(audio.durationMs),
    environmentLabel,
    blocksSubmission: () => voiceInputBlocksSubmission(controller.currentState),
    start: () => void controller.start(),
    confirm: () => void session.confirm(),
    /** Inserts the transcript, then submits the draft the transcript landed in. */
    send: async (submit: () => void) => {
      if (await session.confirm()) submit();
    },
    cancel: session.cancel,
    dismissError: () => controller.cancel(),
    openMicrophoneSettings: () =>
      void window.desktopBridge?.openSystemSettings?.("microphone").catch(() => false),
    voiceControl: {
      disabled: !options.enabled || active,
      onClick: () => void controller.start(),
    },
  };
}

async function resolveComposerVoiceContext(
  environmentId: EnvironmentId,
): Promise<EnvironmentVoiceRequestContext | null> {
  const [{ connectionAtomRuntime }, { appAtomRegistry }, { readPreparedConnection }] =
    await Promise.all([
      import("../../connection/runtime"),
      import("../../rpc/atomRegistry"),
      import("../../state/session"),
    ]);
  const command = createRuntimeCommand(connectionAtomRuntime, {
    label: "web:composer:voice-context",
    execute: Effect.fn("composerVoice.resolveContext")(function* (
      targetEnvironmentId: EnvironmentId,
    ) {
      const prepared = readPreparedConnection(targetEnvironmentId);
      if (!prepared) return null;
      return yield* resolveEnvironmentVoiceContext(prepared);
    }),
  });
  const result = await command.run(appAtomRegistry, environmentId);
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}
