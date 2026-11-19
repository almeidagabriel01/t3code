import {
  ASSISTANT_PRESENCE_SECTIONS,
  assistantPresenceSections,
  assistantPresenceStatus,
  assistantSenderLook,
  assistantSenders,
  assistantThreadSenders,
  type AssistantSender,
} from "@t3tools/client-runtime/assistantPresence";
import type { AssistantFace } from "@t3tools/client-runtime/assistantRobot";
import {
  assistantTaskState,
  canDismissAssistantTask,
  type AssistantTaskState,
} from "@t3tools/client-runtime/assistantTasks";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAssistantThreadId,
  type AssistantToolAccess,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  CrosshairIcon,
  EllipsisIcon,
  InfoIcon,
  MessagesSquareIcon,
  RotateCcwIcon,
  ShieldIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { useQuietThreadProjection, useThreadShell } from "../../state/entities";
import {
  useAssistantActions,
  useAssistantEntries,
  useAssistantTask,
  useTaskAssistant,
} from "../../state/assistants";
import {
  AssistantAvatar,
  AssistantCluster,
  removedAssistantFace,
  TOOL_ACCESS_OPTIONS,
} from "../assistants/assistantPresentation";
import { openAssistantInfo } from "../assistants/assistantInfoState";
import { useAssistantFlows } from "../assistants/useAssistantFlows";
import { useAssistantStatus } from "../sidebar/useSidebarZones";
import { useUsageLimitLabel } from "../assistants/useUsageLimitLabel";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { jumpToTimelineMessage } from "./timelineJump";

const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function AssistantPresenceRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadKey: string;
  readonly sender: AssistantSender;
  readonly face: AssistantFace;
  /** Its status word from the shared status: the section's title, or what failed or holds it. */
  readonly label: string;
  /** Set on the row of the assistant that launched this thread as a task. */
  readonly task: {
    readonly threadId: ThreadId;
    readonly state: AssistantTaskState;
    readonly dismissed: boolean;
  } | null;
  readonly onDone: () => void;
}) {
  const { sender, environmentId, task, label } = props;
  const { assistant } = sender;
  const actions = useAssistantActions(environmentId);
  const flows = useAssistantFlows(environmentId);
  const name = assistant?.name ?? "Assistant";
  const openInfo = () => {
    if (!assistant) return;
    props.onDone();
    openAssistantInfo({ kind: "assistant", environmentId, assistantId: assistant.id });
  };
  const saveAccess = async (toolAccess: AssistantToolAccess) => {
    if (!assistant || toolAccess === assistant.toolAccess) return;
    const reply = await actions.update({ assistantId: assistant.id, toolAccess });
    if (!reply.ok) {
      toastManager.add({
        type: "error",
        title: "Could not change the access",
        description: reply.message,
      });
    }
  };
  return (
    <div
      role={assistant ? "button" : undefined}
      tabIndex={assistant ? 0 : undefined}
      aria-label={assistant ? `${name}, Assistant info` : undefined}
      data-assistant-presence-row={name}
      className={`flex min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1.5 ${
        assistant ? `cursor-pointer hover:bg-foreground/8 ${FOCUS_RING}` : ""
      }`}
      onClick={openInfo}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openInfo();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AssistantAvatar
          assistant={assistant ?? removedAssistantFace(sender.assistantId)}
          environmentId={environmentId}
          mood={props.face}
          className="size-5"
        />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{name}</p>
        {sender.count === 0 ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Jump to ${name}'s last message`}
                  onClick={(event) => {
                    event.stopPropagation();
                    jumpToTimelineMessage(props.threadKey, sender.lastMessageId);
                    props.onDone();
                  }}
                />
              }
            >
              <CrosshairIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Jump to last message</TooltipPopup>
          </Tooltip>
        )}
        {assistant ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`${name} actions`}
                  onClick={(event) => event.stopPropagation()}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup
              align="end"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <MenuSub>
                <MenuSubTrigger disabled={!actions.canAct}>
                  <ShieldIcon />
                  Access
                </MenuSubTrigger>
                <MenuSubPopup>
                  <MenuRadioGroup
                    value={assistant.toolAccess}
                    onValueChange={(value) => void saveAccess(value as AssistantToolAccess)}
                  >
                    {TOOL_ACCESS_OPTIONS.map((option) => (
                      <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                        {option.label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuSubPopup>
              </MenuSub>
              <MenuItem
                disabled={assistant.threadId === null}
                onClick={() => {
                  props.onDone();
                  flows.openConversation(assistant);
                }}
              >
                <MessagesSquareIcon />
                Open chat
              </MenuItem>
              <MenuItem onClick={openInfo}>
                <InfoIcon />
                Assistant info
              </MenuItem>
              {task === null ? null : task.dismissed ? (
                <MenuItem
                  disabled={!flows.canAct}
                  onClick={() => void flows.restoreTask(task.threadId)}
                >
                  <RotateCcwIcon />
                  Restore task
                </MenuItem>
              ) : (
                <MenuItem
                  disabled={!flows.canAct || !canDismissAssistantTask(task.state)}
                  onClick={() => void flows.dismissTask(task.threadId)}
                >
                  <XIcon />
                  Dismiss task
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      <p
        data-assistant-presence-status
        className="truncate ps-7 text-xs whitespace-nowrap text-muted-foreground"
      >
        {assistantPresenceStatus(label, sender, assistant?.askBeforeActing === true)}
      </p>
    </div>
  );
}

function PresenceSection(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section aria-label={props.title} className="flex min-w-0 flex-col">
      <h3 className="px-1.5 pt-1.5 pb-0.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

/**
 * The header's one assistant control: who from your assistants spoke in this thread or launched it
 * as a task, what each is doing (its shared status: Needs you, Working, Idle), and a way to its info.
 */
export function AssistantPresenceStack(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const [open, setOpen] = useState(false);
  const isAssistantThread = isAssistantThreadId(threadId);
  const projection = useQuietThreadProjection(
    isAssistantThread ? null : scopeThreadRef(environmentId, threadId),
  );
  const { active, archived } = useAssistantEntries();
  const status = useAssistantStatus();
  const limitLabel = useUsageLimitLabel();
  const owner = useTaskAssistant(environmentId, threadId);
  const taskShell = useThreadShell(owner === null ? null : scopeThreadRef(environmentId, threadId));
  const taskRecord = useAssistantTask(environmentId, threadId);
  if (isAssistantThread || !projection) return null;
  const senders = assistantThreadSenders(
    assistantSenders(
      projection.projection.messages,
      [...active, ...archived]
        .filter((entry) => entry.environmentId === environmentId)
        .map((entry) => entry.assistant),
    ),
    owner?.assistant ?? null,
  );
  if (senders.length === 0) return null;
  const task =
    owner === null
      ? null
      : {
          assistantId: owner.assistant.id,
          threadId,
          state: taskShell === null ? ("running" as const) : assistantTaskState(taskShell),
          dismissed: taskRecord?.dismissedAt != null,
        };
  const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const looks = new Map(
    senders.map((sender) => [
      sender.assistantId,
      assistantSenderLook(sender, status.of(environmentId, sender.assistant, limitLabel)),
    ]),
  );
  const taskOf = (sender: AssistantSender) =>
    task !== null && task.assistantId === sender.assistantId ? task : null;
  const faceOf = (sender: AssistantSender) => looks.get(sender.assistantId)?.face ?? "sleeping";
  const sectionOf = (sender: AssistantSender) => looks.get(sender.assistantId)?.section ?? "idle";
  const sections = assistantPresenceSections(senders, sectionOf);
  const row = (sender: AssistantSender) => (
    <AssistantPresenceRow
      key={sender.assistantId}
      environmentId={environmentId}
      threadKey={threadKey}
      sender={sender}
      face={faceOf(sender)}
      label={looks.get(sender.assistantId)?.label ?? "Idle"}
      task={taskOf(sender)}
      onDone={() => setOpen(false)}
    />
  );
  return (
    // Always shown: no other entry reaches these rows' actions, so a narrow header truncates its title instead.
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Assistants in this thread: ${senders.length}`}
            className={`flex shrink-0 cursor-pointer items-center rounded-md p-0.5 transition-colors hover:bg-foreground/8 [-webkit-app-region:no-drag] ${FOCUS_RING}`}
          />
        }
      >
        <AssistantCluster
          environmentId={environmentId}
          className="size-6"
          faces={senders.map((sender) => ({
            key: sender.assistantId,
            assistant: sender.assistant ?? removedAssistantFace(sender.assistantId),
            mood: faceOf(sender),
          }))}
        />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="md" padding="compact">
        <h2 className="px-1.5 pt-0.5 pb-1 text-xs font-medium text-muted-foreground">
          Assistants in this thread · {senders.length}
        </h2>
        {ASSISTANT_PRESENCE_SECTIONS.map(([id, title]) =>
          sections[id].length === 0 ? null : (
            <PresenceSection key={id} title={title}>
              {sections[id].map(row)}
            </PresenceSection>
          ),
        )}
      </PopoverPopup>
    </Popover>
  );
}
