import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import {
  ComposerSpeechButton,
  ComposerSpeechRecordingPill,
} from "~/components/chat/ComposerSpeechButton";
import { VoiceInputSetup } from "~/components/chat/VoiceInputSetup";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useDictationShortcut } from "./useDictationShortcut";
import { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";

/**
 * Binds dictation to a plain textarea draft; the shortcut targets it only while it has focus. A
 * field that is not a textarea reads and places its own selection.
 */
export function useTextFieldSpeech(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | null | undefined;
  readonly ownerKey: string;
  readonly text: string;
  readonly textareaRef: RefObject<HTMLElement | null>;
  readonly selection?: {
    readonly read: () => { readonly start: number; readonly end: number };
    readonly place: (selection: { readonly start: number; readonly end: number }) => void;
  };
  readonly onTextChange: (text: string) => void;
  readonly disabled?: boolean | undefined;
}) {
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed field callbacks to the asynchronous recording controller
  useEffect(() => {
    latest.current = input;
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const speech = useEnvironmentSpeechInput({
    environmentId: input.environmentId,
    projectId: input.projectId,
    ownerKey: input.ownerKey,
    draftText: input.text,
    disabled: input.disabled,
    offerSetup: false,
    readDraft: () => {
      const custom = latest.current.selection;
      if (custom) return { text: latest.current.text, selection: custom.read() };
      const field = latest.current.textareaRef.current;
      if (!(field instanceof HTMLTextAreaElement)) {
        const end = latest.current.text.length;
        return { text: latest.current.text, selection: { start: end, end } };
      }
      return {
        text: field.value,
        selection: { start: field.selectionStart, end: field.selectionEnd },
      };
    },
    commitDraft: (text, selection) => {
      latest.current.onTextChange(text);
      window.requestAnimationFrame(() => {
        const custom = latest.current.selection;
        if (custom) return custom.place(selection);
        const field = latest.current.textareaRef.current;
        if (!(field instanceof HTMLTextAreaElement)) return;
        field.focus({ preventScroll: true });
        field.setSelectionRange(selection.start, selection.end);
      });
    },
  });
  const shortcutLabel = useDictationShortcut({
    keybindings,
    speech,
    disabled: input.disabled ?? false,
    terminalOpen: false,
    modelPickerOpen: false,
    targetRef: input.textareaRef,
  });
  return { ...speech, shortcutLabel };
}

export type TextFieldSpeech = ReturnType<typeof useTextFieldSpeech>;

export function TextFieldSpeechControls({
  speech,
  disabled = false,
}: {
  speech: TextFieldSpeech;
  disabled?: boolean;
}) {
  return (
    <>
      {speech.preview ? (
        <p role="status" className="w-full text-sm text-muted-foreground">
          {speech.preview.committed}
          <span className="opacity-70">{speech.preview.tentative}</span>
        </p>
      ) : null}
      <div className="flex min-w-0 items-center gap-1">
        <ComposerSpeechRecordingPill
          state={speech.state}
          progress={null}
          level={speech.level}
          finishShortcutLabel={speech.shortcutLabel}
          cancelShortcutLabel="Esc"
          disabled={disabled}
          onStart={() => void speech.start()}
          onStop={() => void speech.stop()}
          onCancel={speech.cancel}
          onSkipPostProcessing={speech.skipPostProcessing}
        />
        {speech.available ? (
          <ComposerSpeechButton
            state={speech.state}
            progress={null}
            shortcutLabel={speech.shortcutLabel}
            disabled={disabled}
            onStart={() => void speech.start()}
            onCancel={speech.cancel}
          />
        ) : null}
      </div>
      <VoiceInputSetup
        environmentId={speech.transcriptionEnvironmentId}
        open={speech.setup.open}
        step={speech.setup.step}
        status={speech.status}
        model={speech.setup.model}
        language={speech.setup.language}
        downloading={speech.setup.downloading}
        error={speech.setup.error}
        onOpenChange={speech.setup.setOpen}
        onRetryCatalog={speech.setup.retryCatalog}
        onDownload={() => void speech.setup.download()}
        onCancelDownload={() => void speech.setup.cancelDownload()}
        onStartRecording={() => void speech.setup.startRecording()}
      />
    </>
  );
}

/** Render-prop form for editors that only sometimes have an environment to dictate on. */
export function SpeechTextField({
  children,
  ...input
}: Parameters<typeof useTextFieldSpeech>[0] & {
  children: (speech: TextFieldSpeech) => ReactNode;
}) {
  return children(useTextFieldSpeech(input));
}
