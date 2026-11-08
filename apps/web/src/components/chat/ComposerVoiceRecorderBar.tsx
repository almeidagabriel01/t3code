import { ArrowUpIcon, CheckIcon, XIcon } from "lucide-react";
import { useEffect } from "react";

import { MAX_WAVEFORM_SAMPLES } from "../../lib/voiceRecorder";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { useComposerVoice } from "./useComposerVoice";

interface ComposerVoiceRecorderBarProps {
  readonly voice: ReturnType<typeof useComposerVoice>;
  readonly onSend: () => void;
  readonly disabled?: boolean;
}

function IconAction(props: {
  readonly label: string;
  readonly tooltip: string;
  readonly onClick: () => void;
  readonly disabled?: boolean | undefined;
  readonly variant?: "ghost" | "default";
  readonly shortcut?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={props.variant ?? "ghost"}
            size="icon-sm"
            aria-label={props.label}
            disabled={props.disabled}
            {...(props.shortcut ? { "data-composer-shortcut": props.shortcut } : {})}
            // The editor keeps focus, so Escape and typing keep working after a click.
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** What the user sees while dictating: where the audio goes, a level meter, and the three ways out. */
export function ComposerVoiceRecorderBar({
  voice,
  onSend,
  disabled,
}: ComposerVoiceRecorderBarProps) {
  const { cancel } = voice;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape cancels the recorder even when focus stays in the editor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [cancel]);

  const busy = voice.isStarting || voice.isTranscribing;
  const status = voice.isTranscribing
    ? "Transcribing…"
    : voice.isStarting || voice.isWaitingForAudio
      ? "Preparing microphone…"
      : `Recording · ${voice.durationLabel}`;
  return (
    <div data-composer-voice-recorder="true" className="flex min-w-0 items-center gap-2 py-1">
      <span
        role="status"
        className="shrink-0 rounded-full bg-foreground/8 px-2 py-1 text-xs tabular-nums text-muted-foreground"
      >
        {status}
      </span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {voice.environmentLabel
          ? `Transcribes on ${voice.environmentLabel}`
          : "Transcribes on this environment"}
      </span>
      <div
        aria-hidden="true"
        className="flex h-7 min-w-0 flex-1 items-center justify-end gap-0.5 overflow-hidden"
      >
        {voice.waveformLevels.slice(-MAX_WAVEFORM_SAMPLES).map((level, index) => (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- Fixed waveform slots have positional identity.
            key={index}
            className="w-0.5 shrink-0 rounded-full bg-foreground/60"
            style={{ height: `${3 + Math.min(1, Math.max(0, level)) * 21}px` }}
          />
        ))}
      </div>
      <IconAction label="Cancel dictation" tooltip="Cancel (Esc)" onClick={cancel}>
        <XIcon aria-hidden="true" />
      </IconAction>
      <IconAction
        label="Insert dictated text"
        shortcut="composer.dictate"
        tooltip="Insert text"
        disabled={busy || disabled}
        onClick={voice.confirm}
      >
        <CheckIcon aria-hidden="true" />
      </IconAction>
      <IconAction
        label="Transcribe and send"
        tooltip="Transcribe and send"
        variant="default"
        disabled={busy || disabled}
        onClick={onSend}
      >
        <ArrowUpIcon aria-hidden="true" />
      </IconAction>
    </div>
  );
}

/** Why dictation stopped; a macOS denial adds the way to fix it. The draft is always untouched. */
export function ComposerVoiceError({
  voice,
}: {
  readonly voice: ReturnType<typeof useComposerVoice>;
}) {
  const { error, errorAction } = voice.state;
  if (!error) return null;
  const canOpenSettings =
    errorAction === "settings" && window.desktopBridge?.getClientPlatform?.() === "darwin";
  return (
    <div className="flex items-center gap-2 px-3 pb-2 sm:px-4">
      <p role="alert" data-composer-voice-error="true" className="min-w-0 text-xs text-destructive">
        {error}
      </p>
      {canOpenSettings ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="shrink-0"
          onClick={voice.openMicrophoneSettings}
        >
          Open System Settings
        </Button>
      ) : null}
      <IconAction label="Dismiss" tooltip="Dismiss" onClick={voice.dismissError}>
        <XIcon aria-hidden="true" />
      </IconAction>
    </div>
  );
}
