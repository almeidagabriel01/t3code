import { assistantSenders } from "@t3tools/client-runtime/assistantPresence";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAssistantThreadId,
  type Assistant,
  type AssistantToolAccess,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { CrosshairIcon } from "lucide-react";
import { useState } from "react";

import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAssistantActions, useAssistantEntries } from "../../state/assistants";
import {
  AssistantAccentAvatar,
  TOOL_ACCESS_OPTIONS,
  toolAccessLabel,
} from "../assistants/assistantPresentation";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { jumpToTimelineMessage } from "./timelineJump";
import { cn } from "~/lib/utils";

const MAX_VISIBLE_AVATARS = 3;

/** Green while the assistant's own conversation is running a turn, muted otherwise. */
function useAssistantWorking(environmentId: EnvironmentId, assistant: Assistant | null) {
  const shell = useQuietThreadShell(
    assistant?.threadId ? scopeThreadRef(environmentId, assistant.threadId) : null,
  );
  return shell?.runtime?.status === "running";
}

function AssistantAvatarWithStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly assistantId: string;
  readonly assistant: Assistant | null;
  readonly className?: string;
}) {
  const working = useAssistantWorking(props.environmentId, props.assistant);
  return (
    <span className="relative inline-flex">
      <AssistantAccentAvatar
        assistantId={props.assistantId}
        name={props.assistant?.name ?? "Assistant"}
        icon={props.assistant?.icon}
        className={cn("size-5.5 text-2xs", props.className)}
      />
      <i
        data-assistant-status={working ? "working" : "idle"}
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-2 border-background",
          working ? "bg-success" : "bg-muted-foreground",
        )}
      />
    </span>
  );
}

function AssistantPresenceRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadKey: string;
  readonly assistantId: string;
  readonly assistant: Assistant | null;
  readonly count: number;
  readonly lastMessageId: string;
  readonly onJumped: () => void;
}) {
  const { assistant } = props;
  const working = useAssistantWorking(props.environmentId, assistant);
  const actions = useAssistantActions(props.environmentId);
  const name = assistant?.name ?? "Assistant";
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
    <div className="flex items-center gap-2.5 px-1 py-1.5" data-assistant-presence-row={name}>
      <AssistantAvatarWithStatus
        environmentId={props.environmentId}
        assistantId={props.assistantId}
        assistant={assistant}
        className="size-7 text-xs"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">
          {working ? "Working" : "Idle"} · {props.count}{" "}
          {props.count === 1 ? "message" : "messages"} here
          {assistant?.askBeforeActing ? " · Asks before acting" : ""}
        </p>
      </div>
      {assistant ? (
        <Select
          value={assistant.toolAccess}
          onValueChange={(value) => void saveAccess(value as AssistantToolAccess)}
        >
          <SelectTrigger
            size="sm"
            className="w-32"
            aria-label={`Access for ${name}`}
            disabled={!actions.canAct}
          >
            <SelectValue>{toolAccessLabel(assistant.toolAccess)}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {TOOL_ACCESS_OPTIONS.map((option) => (
              <SelectItem hideIndicator key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Jump to ${name}'s last message`}
              onClick={() => {
                jumpToTimelineMessage(props.threadKey, props.lastMessageId);
                props.onJumped();
              }}
            />
          }
        >
          <CrosshairIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Jump to last message</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** Who from your assistants spoke in this thread, with a way to see them work and set their access. */
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
  if (isAssistantThread || !projection) return null;
  const senders = assistantSenders(
    projection.projection.messages,
    [...active, ...archived]
      .filter((entry) => entry.environmentId === environmentId)
      .map((entry) => entry.assistant),
  );
  if (senders.length === 0) return null;
  const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const visible = senders.slice(0, MAX_VISIBLE_AVATARS);
  return (
    // Narrow headers give the title room; the same assistants stay reachable from the minimap marks.
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Assistants in this thread: ${senders.length}`}
            className="flex shrink-0 cursor-pointer items-center rounded-full border border-foreground/12 py-0.5 pe-1.5 ps-0.5 transition-colors hover:bg-foreground/8 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @max-xl/header:hidden [-webkit-app-region:no-drag]"
          />
        }
      >
        {visible.map((sender, index) => (
          <span key={sender.assistantId} className={cn(index > 0 && "-ml-1.5")}>
            <AssistantAvatarWithStatus
              environmentId={environmentId}
              assistantId={sender.assistantId}
              assistant={sender.assistant}
            />
          </span>
        ))}
        {senders.length > MAX_VISIBLE_AVATARS ? (
          <span className="ms-1.5 text-2xs text-muted-foreground tabular-nums">
            +{senders.length - MAX_VISIBLE_AVATARS}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="md" padding="compact">
        <div className="flex flex-col divide-y divide-foreground/8">
          {senders.map((sender) => (
            <AssistantPresenceRow
              key={sender.assistantId}
              environmentId={environmentId}
              threadKey={threadKey}
              assistantId={sender.assistantId}
              assistant={sender.assistant}
              count={sender.count}
              lastMessageId={sender.lastMessageId}
              onJumped={() => setOpen(false)}
            />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
