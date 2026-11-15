import { assistantPresence } from "@t3tools/client-runtime/assistantRobot";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_GROUP_STATUS_LABEL,
  assistantGroupTaskReasonLabel,
  assistantGroupWaitingReason,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  assistantGroupTaskActions,
  type Assistant,
  type AssistantGroupTask,
  type AssistantGroupTaskAction,
  type EnvironmentId,
} from "@t3tools/contracts";
import { MessageSquareIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { AssistantAvatar } from "./assistantPresentation";
import { useUsageLimitLabel } from "./useUsageLimitLabel";

const STATUS_TONE = {
  queued: "text-muted-foreground",
  running: "text-info-foreground",
  waiting: "text-warning-foreground",
  usage_limited: "text-warning-foreground",
  completed: "text-success-foreground",
  paused: "text-warning-foreground",
  cancelled: "text-muted-foreground",
  failed: "text-destructive-foreground",
} as const;

const ACTION_LABEL: Record<Exclude<AssistantGroupTaskAction, "reassign">, string> = {
  stop: "Stop",
  resume: "Resume",
  cancel: "Cancel",
};

/** One task of a request: its state, what was asked, and what the user can do with it. */
export function GroupTaskCard(props: {
  readonly task: AssistantGroupTask;
  readonly environmentId: EnvironmentId;
  /** Shown when the card is not under its owner's own message. */
  readonly owner?: Assistant | undefined;
  /** Active members that can take the task over, without its owner. */
  readonly reassignTo: ReadonlyArray<Assistant>;
  readonly canAct: boolean;
  readonly onAction: (action: AssistantGroupTaskAction, ownerId?: Assistant["id"]) => void;
  readonly onOpenConversation: () => void;
}) {
  const { task } = props;
  const actions = assistantGroupTaskActions(task);
  // A running member that waits on an approval or a question is answered in its own thread.
  const shell = useThreadShell(
    task.status === "running" ? scopeThreadRef(props.environmentId, task.threadId) : null,
  );
  const presence = shell === null ? null : assistantPresence(shell);
  const needs = presence?.mood === "needs" ? presence.detail : null;
  const limitLabel = useUsageLimitLabel();
  const waiting =
    task.status === "usage_limited" ? limitLabel(task.resetAt) : assistantGroupWaitingReason(task);
  const reasonLabel = assistantGroupTaskReasonLabel(task);
  return (
    <div
      data-testid="group-task-card"
      data-status={task.status}
      className="mt-1.5 flex min-w-0 flex-col gap-1.5 rounded-xl border border-foreground/10 bg-foreground/2 px-3 py-2.5 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        {props.owner === undefined ? null : (
          <span className="flex min-w-0 shrink items-center gap-1.5 font-medium">
            <AssistantAvatar
              assistant={props.owner}
              environmentId={props.environmentId}
              className="size-4"
            />
            <span className="truncate">{props.owner.name}</span>
          </span>
        )}
        <span
          className={cn("flex shrink-0 items-center gap-1.5 font-medium", STATUS_TONE[task.status])}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {ASSISTANT_GROUP_STATUS_LABEL[task.status]}
        </span>
        <span className="ms-auto shrink-0 text-muted-foreground tabular-nums">
          <RelativeTime timestamp={task.updatedAt} />
        </span>
      </div>
      <p className="line-clamp-3 text-sm wrap-anywhere text-foreground">{task.instruction}</p>
      {task.expectedResult === undefined ? null : (
        <p data-testid="group-task-expected" className="truncate text-muted-foreground">
          Expected: {task.expectedResult}
        </p>
      )}
      {task.resources === undefined ? null : (
        <div data-testid="group-task-resources" className="flex flex-wrap gap-1">
          {task.resources.map((resource) => (
            <Badge key={resource} variant="outline" size="sm">
              {resource}
            </Badge>
          ))}
        </div>
      )}
      {waiting === null ? null : (
        <p data-testid="group-task-waiting" className="text-warning-foreground">
          {waiting}
        </p>
      )}
      {reasonLabel === null ? null : <p className="text-muted-foreground">{reasonLabel}</p>}
      {needs === null ? null : (
        <p data-testid="group-task-needs" className="font-medium text-warning-foreground">
          {needs} · Open the conversation to answer
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {actions.map((action) =>
          action === "reassign" ? (
            <Menu key={action}>
              <MenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!props.canAct || props.reassignTo.length === 0}
                  />
                }
              >
                Reassign
              </MenuTrigger>
              <MenuPopup align="start">
                {props.reassignTo.map((member) => (
                  <MenuItem key={member.id} onClick={() => props.onAction("reassign", member.id)}>
                    {member.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : (
            <Button
              key={action}
              size="xs"
              variant="outline"
              disabled={!props.canAct}
              onClick={() => props.onAction(action)}
            >
              {ACTION_LABEL[action]}
            </Button>
          ),
        )}
        <Button
          size="xs"
          variant={needs === null ? "ghost-muted" : "outline"}
          onClick={props.onOpenConversation}
        >
          <MessageSquareIcon />
          Open conversation
        </Button>
      </div>
    </div>
  );
}
