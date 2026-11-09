import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_TASK_FACE,
  ASSISTANT_TASK_STATE_LABEL,
  assistantTaskState,
} from "@t3tools/client-runtime/assistantTasks";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useTaskAssistant } from "../../state/assistants";
import { useThreadShell } from "../../state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AssistantAvatar } from "./assistantPresentation";
import { useAssistantFlows } from "./useAssistantFlows";

/** The face of the assistant that launched this thread, in the mood of the work; click goes to it. */
export function AssistantTaskBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const owner = useTaskAssistant(environmentId, threadId);
  const shell = useThreadShell(owner === null ? null : scopeThreadRef(environmentId, threadId));
  const flows = useAssistantFlows(environmentId);
  if (owner === null) return null;
  const state = shell === null ? "running" : assistantTaskState(shell);
  const label = `Task of ${owner.assistant.name}, ${ASSISTANT_TASK_STATE_LABEL[state].toLowerCase()}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            data-testid="assistant-task-badge"
            data-state={state}
            disabled={owner.assistant.threadId === null}
            onClick={() => flows.openConversation(owner.assistant)}
            className="flex shrink-0 cursor-pointer items-center rounded-full border border-foreground/12 p-0.5 transition-colors hover:bg-foreground/8 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default @max-xl/header:hidden [-webkit-app-region:no-drag]"
          />
        }
      >
        <AssistantAvatar
          assistant={owner.assistant}
          environmentId={environmentId}
          mood={ASSISTANT_TASK_FACE[state]}
          className="size-5.5"
        />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
