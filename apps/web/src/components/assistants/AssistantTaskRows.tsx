import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_TASK_FACE,
  ASSISTANT_TASK_STATE_LABEL,
  assistantTaskRows,
  canDismissAssistantTask,
  type AssistantTaskRow,
  type AssistantTaskSections,
  type AssistantTaskState,
} from "@t3tools/client-runtime/assistantTasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useClientSettings } from "../../hooks/useSettings";
import { useAssistantTasks, type AssistantEntry } from "../../state/assistants";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { useQuietThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { sortOpenThreadsForSidebar } from "../Sidebar.logic";
import { AssistantAvatar } from "./assistantPresentation";
import { useAssistantFlows } from "./useAssistantFlows";

const STATE_TEXT: Record<AssistantTaskState, string> = {
  running: "text-info-foreground",
  waiting: "text-warning-foreground",
  failed: "text-destructive-foreground",
  done: "text-muted-foreground",
};

const NO_SECTIONS: AssistantTaskSections<EnvironmentThreadShell> = { open: [], settled: [] };

/** The assistant's task threads split and ordered exactly as a project's thread list. */
export function useAssistantTaskSections(
  entry: AssistantEntry,
): AssistantTaskSections<EnvironmentThreadShell> {
  const { assistant, environmentId } = entry;
  const tasks = useAssistantTasks(environmentId, assistant.id);
  const shells = useQuietThreadShells();
  const threadOrder = useClientSettings((settings) => settings.sidebarThreadOrder);
  const lastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const openDecisionKeys = useOpenDecisionThreadKeys();
  if (tasks.length === 0) return NO_SECTIONS;
  const byId = new Map(
    shells.filter((shell) => shell.environmentId === environmentId).map((s) => [s.id, s]),
  );
  return assistantTaskRows(
    tasks,
    (threadId) => byId.get(threadId as never),
    (open) =>
      sortOpenThreadsForSidebar(open, threadOrder, { lastVisitedAtByKey, openDecisionKeys }),
  );
}

/**
 * The threads an assistant launched, one line each: its face in the task's mood, the title and the
 * state. Settled ones fold into a Settled shelf, as in a project. Nothing renders while it has none.
 */
export const AssistantTaskRows = memo(function AssistantTaskRows(props: {
  readonly entry: AssistantEntry;
  readonly sections: AssistantTaskSections<EnvironmentThreadShell>;
  readonly activeThreadKey?: string | null | undefined;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  /** Larger rows and no left rule, for the assistant page. */
  readonly roomy?: boolean;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const [settledExpanded, setSettledExpanded] = useState(false);
  const { open, settled } = props.sections;
  if (open.length === 0 && settled.length === 0) return null;
  const renderRow = ({ task, shell, state }: AssistantTaskRow<EnvironmentThreadShell>) => (
    <li
      key={task.threadId}
      className={cn(
        "flex list-none items-center rounded-md py-px pe-1 hover:bg-foreground/8",
        props.roomy ? "h-9" : "h-7",
      )}
    >
      <button
        type="button"
        data-testid="assistant-task-row"
        data-state={state}
        aria-label={`${shell.title}, ${ASSISTANT_TASK_STATE_LABEL[state]}`}
        aria-current={
          props.activeThreadKey === `${environmentId}:${task.threadId}` ? "page" : undefined
        }
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset,0.5rem) text-left text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => props.onOpen(scopeThreadRef(environmentId, task.threadId))}
      >
        <AssistantAvatar
          assistant={assistant}
          mood={ASSISTANT_TASK_FACE[state]}
          className="size-4"
        />
        <span className="min-w-0 flex-1 truncate">{shell.title}</span>
        <span className={cn("shrink-0 font-normal", STATE_TEXT[state])}>
          {ASSISTANT_TASK_STATE_LABEL[state]}
        </span>
      </button>
      {canDismissAssistantTask(state) ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={`Dismiss ${shell.title}`}
                disabled={!flows.canAct}
                onClick={() => void flows.dismissTask(task.threadId)}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">Dismiss task</TooltipPopup>
        </Tooltip>
      ) : null}
    </li>
  );
  return (
    <ul
      aria-label={`${assistant.name} tasks`}
      data-testid="assistant-task-list"
      className={cn("m-0 p-0", !props.roomy && "ms-3.5 border-s border-foreground/10")}
    >
      {open.map(renderRow)}
      {settled.length === 0 ? null : (
        <li className="list-none">
          <CollapsibleSectionHeader
            expanded={settledExpanded}
            data-testid="assistant-settled-toggle"
            onClick={() => setSettledExpanded((value) => !value)}
            accessory={<span className="font-normal tabular-nums">{settled.length}</span>}
          >
            Settled
          </CollapsibleSectionHeader>
        </li>
      )}
      {settledExpanded ? settled.map(renderRow) : null}
    </ul>
  );
});
