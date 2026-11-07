import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useAssistantsEnvironmentIds } from "../../state/assistants";
import { useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

export function describeAssistantPrompt(description: string): string {
  return `Create this with the t3_assistant tool. If I did not say the access level, ask me whether I want the default (up to your level) or a custom setup before creating it.\n\n${description.trim()}`;
}

/**
 * Opens a Scratch thread with the user's description ready to send, as web does. Resolves to a
 * message when it could not, and to null once the draft is open (or the user moved on).
 */
export function useStartDescribeAssistant() {
  const selectDetail = useSelectWorkspaceDetail();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const environmentIds = useAssistantsEnvironmentIds();
  const configs = useServerConfigs();
  return async (description: string): Promise<string | null> => {
    const environmentId = environmentIds.find(
      (id) => (configs.get(id)?.scratchWorkspaceRoot ?? null) !== null,
    );
    if (environmentId === undefined) return "No Scratch project is available here.";
    const scratch = await openScratch({ environmentId, input: {} });
    if (scratch._tag === "Failure") {
      if (isAtomCommandInterrupted(scratch)) return null;
      const failure = squashAtomCommandFailure(scratch);
      return failure instanceof Error ? failure.message : "Could not open a thread.";
    }
    try {
      await waitForComposerDraftsLoaded();
    } catch {
      return "Drafts could not be loaded.";
    }
    const draftId = createNewTaskDraft({ environmentId, projectId: scratch.value.id });
    setComposerDraftText(draftId, describeAssistantPrompt(description));
    selectDetail({
      name: "Thread",
      params: {
        draft: { environmentId, projectId: scratch.value.id, title: "New assistant", draftId },
      },
    });
    return null;
  };
}
