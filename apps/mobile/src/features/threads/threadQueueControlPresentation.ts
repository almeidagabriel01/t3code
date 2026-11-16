import {
  canEditQueuedMessage,
  resolveUserMessagePresentation,
} from "@t3tools/client-runtime/user-message";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { taskEventActivity } from "@t3tools/client-runtime/assistantTasks";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";

export const REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL = "Remove queued message";

export interface ThreadQueueRowControls {
  readonly canDismiss: boolean;
  readonly canEdit: boolean;
  readonly canSend: boolean;
  readonly dismissAccessibilityLabel: string;
  readonly displayText: string;
  readonly isEditing: boolean;
}

export function resolveThreadQueueRowControls(input: {
  readonly busy: boolean;
  readonly canPromoteToSteer: boolean;
  readonly canSendNow: boolean;
  /** Something else holds the composer, such as an open question. */
  readonly editBlocked?: boolean;
  readonly isEditing?: boolean;
  readonly text: string;
  /** The queued message; a teammate's shows their words, and only the owner's own can be edited. */
  readonly message?:
    | (Parameters<typeof resolveUserMessagePresentation>[0] &
        Parameters<typeof canEditQueuedMessage>[0])
    | undefined;
}): ThreadQueueRowControls {
  const presentation = input.message ? resolveUserMessagePresentation(input.message) : null;
  const shownText = presentation?.teammate ? presentation.text : input.text;
  const mutationEnabled = !input.busy;
  const isEditing = input.isEditing === true;

  return {
    canDismiss: !input.busy,
    // Re-opening the row already in the composer would reload it and throw
    // away whatever has been typed since.
    canEdit:
      mutationEnabled &&
      !isEditing &&
      canEditQueuedMessage(input.message) &&
      input.editBlocked !== true,
    canSend: mutationEnabled && (input.canPromoteToSteer || input.canSendNow) && !isEditing,
    dismissAccessibilityLabel: REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
    // Editing and sending keep the original text so quoted citations stay linked.
    displayText: isAttachmentOnlyBootstrapPrompt(shownText)
      ? ""
      : assistantCitationsToPlainText(shownText),
    isEditing,
  };
}

export function buildCancelQueuedRunCommand(input: {
  readonly environmentId: EnvironmentId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}): {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly runId: RunId;
    readonly threadId: ThreadId;
  };
} {
  return {
    environmentId: input.environmentId,
    input: {
      runId: input.runId,
      threadId: input.threadId,
    },
  };
}

/** A task event shows as "<title> · <label>"; other messages keep their text. */
export function queuedRowTitle(input: {
  readonly message: Parameters<typeof taskEventActivity>[0] | undefined;
  readonly displayText: string;
  readonly hasAttachments: boolean;
}) {
  const taskEvent = input.message ? taskEventActivity(input.message) : null;
  return (
    (taskEvent && `${taskEvent.title} · ${taskEvent.label}`) ||
    input.displayText ||
    (input.hasAttachments ? "Attachments" : "Queued message")
  );
}
