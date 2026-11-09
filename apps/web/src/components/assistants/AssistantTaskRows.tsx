import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_TASK_FACE,
  ASSISTANT_TASK_STATE_LABEL,
  assistantTaskRows,
  type AssistantTaskState,
} from "@t3tools/client-runtime/assistantTasks";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { useAssistantTasks, type AssistantEntry } from "../../state/assistants";
import { useQuietThreadShells } from "../../state/entities";
import { AssistantAvatar } from "./assistantPresentation";

const STATE_TEXT: Record<AssistantTaskState, string> = {
  running: "text-info-foreground",
  waiting: "text-warning-foreground",
  failed: "text-destructive-foreground",
  done: "text-muted-foreground",
};

/** Finished tasks fade out of the list; open and failed ones stay until the thread is gone. */
const MAX_DONE = 2;

/**
 * The threads an assistant launched, one line each: its face in the task's mood, the title and the
 * state. A click opens the thread. Nothing renders while it has none.
 */
export const AssistantTaskRows = memo(function AssistantTaskRows(props: {
  readonly entry: AssistantEntry;
  readonly activeThreadKey?: string | null | undefined;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  /** Larger rows and no left rule, for the assistant page. */
  readonly roomy?: boolean;
}) {
  const { assistant, environmentId } = props.entry;
  const tasks = useAssistantTasks(environmentId, assistant.id);
  const shells = useQuietThreadShells();
  const rows = (() => {
    if (tasks.length === 0) return [];
    const byId = new Map(
      shells.filter((shell) => shell.environmentId === environmentId).map((s) => [s.id, s]),
    );
    const all = assistantTaskRows(tasks, (threadId) => byId.get(threadId as never));
    const shownDone = new Set(all.filter((row) => row.state === "done").slice(0, MAX_DONE));
    return all.filter((row) => row.state !== "done" || shownDone.has(row));
  })();
  if (rows.length === 0) return null;
  return (
    <ul
      aria-label={`${assistant.name} tasks`}
      data-testid="assistant-task-list"
      className={cn("m-0 p-0", !props.roomy && "ms-3.5 border-s border-foreground/10")}
    >
      {rows.map(({ task, shell, state }) => (
        <li key={task.threadId} className="list-none py-px">
          <button
            type="button"
            data-testid="assistant-task-row"
            data-state={state}
            aria-label={`${shell.title}, ${ASSISTANT_TASK_STATE_LABEL[state]}`}
            aria-current={
              props.activeThreadKey === `${environmentId}:${task.threadId}` ? "page" : undefined
            }
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset,0.5rem) text-left text-xs outline-none select-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              props.roomy ? "h-9" : "h-7",
            )}
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
        </li>
      ))}
    </ul>
  );
});
