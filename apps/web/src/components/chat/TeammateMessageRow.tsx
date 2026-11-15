import { assistantIdFromThreadId, assistantTransferList, ThreadId } from "@t3tools/contracts";
import { assistantAccent } from "@t3tools/client-runtime/assistantPresence";
import {
  TEAMMATE_STATUS_LABEL,
  teammateMessageIsLong,
  type TeammateMessagePart,
} from "@t3tools/client-runtime/teammateMessage";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { use, useState } from "react";

import { cn } from "~/lib/utils";
import { useAssistantEntries } from "../../state/assistants";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import {
  AssistantAvatar,
  removedAssistantFace,
  toolAccessLabel,
} from "../assistants/assistantPresentation";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { findRevealRef } from "./markdownFindContext";
import { MessageCopyButton } from "./MessageCopyButton";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading } from "./TimelineRowParts";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";

const STATUS_BADGE_VARIANT = {
  done: "success",
  partial: "warning",
  blocked: "error",
} as const;

const COLLAPSED_FADE_MASK = "linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)";

/** The assistant behind a part, live from the directory so renames and role changes show. */
function useTeammate(threadId: string) {
  const ctx = use(TimelineRowCtx);
  const { active, archived } = useAssistantEntries();
  const assistantId = assistantIdFromThreadId(threadId) ?? threadId;
  const assistant = [...active, ...archived].find(
    (entry) =>
      entry.environmentId === ctx.activeThreadEnvironmentId && entry.assistant.id === assistantId,
  )?.assistant;
  return { assistantId, assistant, face: assistant ?? removedAssistantFace(assistantId) };
}

/**
 * Another assistant speaking in this conversation, as a participant: who they are, how their
 * request went, and their words rendered like any assistant answer. A group's replies arrive as
 * one message and show as one block per teammate.
 */
export function TeammateMessageRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const presentation = resolveUserMessagePresentation(row.message);
  const senderThreadId = row.message.senderThreadId;
  const parts: ReadonlyArray<TeammateMessagePart> = presentation.teammate ?? [
    {
      kind: "request",
      name: "Assistant",
      handle: "",
      threadId: senderThreadId ?? "",
      requestId: "",
      expectsReply: undefined,
      status: undefined,
      files: [],
      text: replaceComposerContextReferences(presentation.text, (reference) => reference.label),
    },
  ];
  const joined = row.assistantJoined ? parts[0]! : undefined;
  return (
    <div
      className={cn("group flex flex-col gap-3", row.continuesSender && "-mt-1.5")}
      data-user-message-attribution="assistant"
    >
      {joined ? <JoinedDivider part={joined} createdAt={row.message.createdAt} /> : null}
      {parts.map((part, index) => (
        <TeammatePartBlock
          key={`${part.kind}:${part.threadId}:${part.requestId}`}
          part={part}
          // A lone message from the same teammate as the row above continues its block.
          continues={row.continuesSender === true && parts.length === 1}
          // Older single sends name no thread of their own; the message's sender is that thread.
          threadId={part.threadId || senderThreadId || ""}
          createdAt={index === parts.length - 1 ? row.message.createdAt : undefined}
          copyText={parts.length === 1 ? presentation.text : part.text}
          timestampFormat={ctx.timestampFormat}
        />
      ))}
    </div>
  );
}

function JoinedDivider({ part, createdAt }: { part: TeammateMessagePart; createdAt: string }) {
  const ctx = use(TimelineRowCtx);
  const { assistantId, assistant, face } = useTeammate(part.threadId);
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-foreground/12 after:h-px after:flex-1 after:bg-foreground/12"
      data-assistant-joined={assistantId}
    >
      <AssistantAvatar assistant={face} className="size-4" />
      <span className="tabular-nums">
        {assistant?.name ?? part.name} joined the conversation ·{" "}
        {formatDayAwareTimestamp(createdAt, ctx.timestampFormat)}
      </span>
    </div>
  );
}

function TeammatePartBlock(props: {
  part: TeammateMessagePart;
  continues: boolean;
  threadId: string;
  createdAt: string | undefined;
  copyText: string;
  timestampFormat: Parameters<typeof formatDayAwareTimestamp>[1];
}) {
  const ctx = use(TimelineRowCtx);
  const { part } = props;
  const { assistantId, assistant, face } = useTeammate(props.threadId);
  const name = assistant?.name ?? part.name;
  const accent = assistantAccent(assistantId);
  const role = assistant?.role ? assistant.role : "assistant";
  const access = assistant ? toolAccessLabel(assistant.toolAccess) : null;
  return (
    <div className="flex items-start gap-2.5" data-teammate-part={part.kind}>
      {props.continues ? (
        <span aria-hidden className="size-7 shrink-0" />
      ) : (
        <AssistantAvatar assistant={face} className="mt-0.5 size-7 shrink-0" />
      )}
      <div className="flex min-w-0 max-w-[46rem] flex-1 flex-col gap-1.5">
        <MessageAuthorHeading>{name}</MessageAuthorHeading>
        {props.continues ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1" aria-hidden>
            <b className="truncate text-sm font-semibold text-foreground">{name}</b>
            <span className="truncate text-xs text-muted-foreground">
              {access ? `${role} · ${access}` : role}
            </span>
            {part.status === undefined ? null : (
              <Badge
                variant={STATUS_BADGE_VARIANT[part.status]}
                size="sm"
                data-teammate-status={part.status}
              >
                {TEAMMATE_STATUS_LABEL[part.status]}
              </Badge>
            )}
          </div>
        )}
        {part.status === undefined ? null : (
          <span className="sr-only">Status: {TEAMMATE_STATUS_LABEL[part.status]}</span>
        )}
        <div
          className="min-w-0 rounded-2xl rounded-tl-sm border px-3.5 py-3"
          style={{
            backgroundColor: `color-mix(in srgb, ${accent} 9%, transparent)`,
            borderColor: `color-mix(in srgb, ${accent} 28%, transparent)`,
          }}
        >
          <TeammateMessageBody text={part.text} files={part.files} />
        </div>
        <div className="flex items-center gap-2 ps-1 text-xs tabular-nums text-muted-foreground">
          {props.threadId ? (
            <InlineButton
              onClick={() => ctx.onOpenThread(ThreadId.make(props.threadId))}
              tone="muted"
            >
              Open thread
            </InlineButton>
          ) : null}
          {props.createdAt === undefined ? null : (
            <Tooltip>
              <TooltipTrigger render={<p className="text-xs tabular-nums" />}>
                {formatDayAwareTimestamp(props.createdAt, props.timestampFormat)}
              </TooltipTrigger>
              <TooltipPopup>
                {formatChatTimestampTooltip(props.createdAt, props.timestampFormat)}
              </TooltipPopup>
            </Tooltip>
          )}
          {props.copyText ? <MessageCopyButton text={props.copyText} variant="ghost" /> : null}
        </div>
      </div>
    </div>
  );
}

/** Long messages open on their first screen and expand once, smoothly, on request. */
function TeammateMessageBody({ text, files }: { text: string; files: ReadonlyArray<string> }) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const revealRef = findRevealRef(() => setExpanded(true));
  const canCollapse = teammateMessageIsLong(text);
  const collapsed = canCollapse && !expanded;
  return (
    <div>
      <div
        ref={revealRef}
        className={cn(
          "overflow-hidden text-sm leading-relaxed [interpolate-size:allow-keywords] motion-safe:transition-[height] motion-safe:duration-300 motion-safe:ease-out",
          collapsed ? "h-80" : "h-auto",
        )}
        data-thread-find-text="true"
        data-thread-find-fold={collapsed ? "" : undefined}
        data-teammate-collapsed={collapsed ? "true" : "false"}
        style={
          collapsed
            ? { WebkitMaskImage: COLLAPSED_FADE_MASK, maskImage: COLLAPSED_FADE_MASK }
            : undefined
        }
      >
        <ChatMarkdown
          text={text}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          lineBreaks={shouldPreserveAssistantLineBreaks(text)}
          skills={ctx.skills}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
          onImageExpand={ctx.onImageExpand}
          className="wrap-anywhere"
        />
        {files.length === 0 ? null : (
          <div className="mt-2 border-t border-foreground/10 pt-2" data-teammate-files="true">
            <ChatMarkdown
              text={assistantTransferList(files)}
              cwd={ctx.markdownCwd}
              threadRef={ctx.threadRef ?? undefined}
              className="wrap-anywhere"
            />
          </div>
        )}
      </div>
      {canCollapse ? (
        <div className="mt-1.5 flex justify-end">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-expanded={expanded}
            data-scroll-anchor-ignore
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show full message"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
