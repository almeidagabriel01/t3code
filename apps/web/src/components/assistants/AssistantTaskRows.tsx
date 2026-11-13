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
import type { AssistantTask, ScopedThreadRef } from "@t3tools/contracts";
import type { SidebarThreadOrder } from "@t3tools/contracts/settings";
import { XIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { useAssistantTasks, type AssistantEntry } from "../../state/assistants";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { useQuietThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import {
  sortOpenThreadsForSidebar,
  type SidebarSection,
  type SidebarThreadAttention,
} from "../Sidebar.logic";
import { AssistantAvatar } from "./assistantPresentation";
import { useAssistantFlows } from "./useAssistantFlows";

const STATE_TEXT: Record<AssistantTaskState, string> = {
  running: "text-info-foreground",
  waiting: "text-warning-foreground",
  failed: "text-destructive-foreground",
  done: "text-muted-foreground",
};

const NO_SECTIONS: AssistantTaskSections<EnvironmentThreadShell> = {
  pinned: [],
  open: [],
  snoozed: [],
  settled: [],
};

/** Where an assistant's fold and its shelves persist, beside the project folds. */
export const assistantFoldKey = ({ environmentId, assistant }: AssistantEntry) =>
  `assistant:${environmentId}:${assistant.id}`;

/** A shelf under an assistant opens on request only, so a missing entry reads as closed. */
export const assistantShelfOpen = (
  folds: Readonly<Record<string, boolean>>,
  foldKey: string,
  shelf: "snoozed" | "settled",
) => folds[`${foldKey}:${shelf}`] === true;

/** The assistant's task threads split and ordered exactly as a project's thread list. */
export function assistantTaskSectionsOf(input: {
  readonly tasks: ReadonlyArray<AssistantTask>;
  readonly shellOf: (threadId: string) => EnvironmentThreadShell | undefined;
  readonly threadOrder: SidebarThreadOrder;
  readonly attention: SidebarThreadAttention;
  readonly nowMs: number;
}): AssistantTaskSections<EnvironmentThreadShell> {
  if (input.tasks.length === 0) return NO_SECTIONS;
  return assistantTaskRows(
    input.tasks,
    input.shellOf,
    (open) => sortOpenThreadsForSidebar(open, input.threadOrder, input.attention),
    { now: new Date(input.nowMs).toISOString() },
  );
}

export function useAssistantTaskSections(
  entry: AssistantEntry,
): AssistantTaskSections<EnvironmentThreadShell> {
  const { assistant, environmentId } = entry;
  const tasks = useAssistantTasks(environmentId, assistant.id);
  const shells = useQuietThreadShells();
  const threadOrder = useClientSettings((settings) => settings.sidebarThreadOrder);
  const lastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const openDecisionKeys = useOpenDecisionThreadKeys();
  const nowMs = useNowMinuteMs();
  const byId = new Map(
    shells.filter((shell) => shell.environmentId === environmentId).map((s) => [s.id, s]),
  );
  return assistantTaskSectionsOf({
    tasks,
    shellOf: (threadId) => byId.get(threadId as never),
    threadOrder,
    attention: { lastVisitedAtByKey, openDecisionKeys },
    nowMs,
  });
}

export type AssistantTaskRowRenderer = (
  thread: EnvironmentThreadShell,
  section: SidebarSection,
  assistantRowKey: string,
  /** Done or failed: its row offers Dismiss where others offer Settle. */
  canDismiss: boolean,
) => ReactNode;

const SECTION_OF = {
  pinned: "pinned",
  open: "active",
  snoozed: "snoozed",
  settled: "settled",
} as const satisfies Record<keyof AssistantTaskSections<EnvironmentThreadShell>, SidebarSection>;

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
  /** The sidebar draws each task as the thread row its project shows, under the assistant's row. */
  readonly renderRow?: AssistantTaskRowRenderer | undefined;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const foldKey = assistantFoldKey(props.entry);
  const snoozedExpanded = useUiStateStore((state) =>
    assistantShelfOpen(state.projectExpandedById, foldKey, "snoozed"),
  );
  const settledExpanded = useUiStateStore((state) =>
    assistantShelfOpen(state.projectExpandedById, foldKey, "settled"),
  );
  const setExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const { pinned, open, snoozed, settled } = props.sections;
  if (pinned.length + open.length + snoozed.length + settled.length === 0) return null;
  const renderCompactRow = ({ task, shell, state }: AssistantTaskRow<EnvironmentThreadShell>) => (
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
  const rowsOf = (key: keyof typeof SECTION_OF) =>
    props.sections[key].map((row) =>
      props.renderRow
        ? props.renderRow(row.shell, SECTION_OF[key], foldKey, canDismissAssistantTask(row.state))
        : renderCompactRow(row),
    );
  return (
    <ul
      aria-label={`${assistant.name} tasks`}
      data-testid="assistant-task-list"
      className={cn("m-0 p-0", !props.roomy && "ms-3.5 border-s border-foreground/10")}
    >
      {rowsOf("pinned")}
      {rowsOf("open")}
      {snoozed.length === 0 ? null : (
        <li className="list-none">
          <CollapsibleSectionHeader
            expanded={snoozedExpanded}
            data-testid="assistant-snoozed-toggle"
            onClick={() => setExpanded(`${foldKey}:snoozed`, !snoozedExpanded)}
            accessory={<span className="font-normal tabular-nums">{snoozed.length}</span>}
          >
            Snoozed
          </CollapsibleSectionHeader>
        </li>
      )}
      {snoozedExpanded ? rowsOf("snoozed") : null}
      {settled.length === 0 ? null : (
        <li className="list-none">
          <CollapsibleSectionHeader
            expanded={settledExpanded}
            data-testid="assistant-settled-toggle"
            onClick={() => setExpanded(`${foldKey}:settled`, !settledExpanded)}
            accessory={<span className="font-normal tabular-nums">{settled.length}</span>}
          >
            Settled
          </CollapsibleSectionHeader>
        </li>
      )}
      {settledExpanded ? rowsOf("settled") : null}
    </ul>
  );
});
