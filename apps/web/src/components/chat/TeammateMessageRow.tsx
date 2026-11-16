import { assistantIdFromThreadId, assistantTransferList, ThreadId } from "@t3tools/contracts";
import { assistantAccent } from "@t3tools/client-runtime/assistantPresence";
import {
  TEAMMATE_STATUS_LABEL,
  type TeammateMessagePart,
} from "@t3tools/client-runtime/teammateMessage";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { use } from "react";

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
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CollapsibleMessageBody } from "./CollapsibleMessageBody";
import { MessageCopyButton } from "./MessageCopyButton";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading } from "./TimelineRowParts";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";

const STATUS_BADGE_VARIANT = {
  done: "success",
  partial: "warning",
  blocked: "error",
} as const;

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
      name: "",
      handle: "",
      threadId: senderThreadId ?? "",
      requestId: "",
      expectsReply: undefined,
      status: undefined,
      files: [],
      text: replaceComposerContextReferences(presentation.text, (reference) => reference.label),
    },
  ];
  return (
    <div
      className={cn("flex flex-col gap-3", row.continuesSender && "-mt-1.5")}
      data-user-message-attribution="assistant"
    >
      {parts.map((part, index) => (
        <TeammatePartBlock
          key={`${part.kind}:${part.threadId}:${part.requestId}`}
          part={part}
          joined={row.assistantJoined}
          joinedAt={row.message.createdAt}
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

function JoinedDivider(props: {
  assistantId: string;
  name: string;
  face: ReturnType<typeof useTeammate>["face"];
  createdAt: string;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-foreground/12 after:h-px after:flex-1 after:bg-foreground/12"
      data-assistant-joined={props.assistantId}
    >
      <AssistantAvatar assistant={props.face} className="size-4" />
      <span className="tabular-nums">
        {props.name} joined the conversation ·{" "}
        {formatDayAwareTimestamp(props.createdAt, ctx.timestampFormat)}
      </span>
    </div>
  );
}

function TeammatePartBlock(props: {
  part: TeammateMessagePart;
  /** Assistants first speaking in this message; each gets its divider above its own block. */
  joined: ReadonlyArray<string> | undefined;
  joinedAt: string;
  continues: boolean;
  threadId: string;
  createdAt: string | undefined;
  copyText: string;
  timestampFormat: Parameters<typeof formatDayAwareTimestamp>[1];
}) {
  const ctx = use(TimelineRowCtx);
  const { part } = props;
  const { assistantId, assistant, face } = useTeammate(props.threadId);
  const name = assistant?.name || part.name || "Assistant";
  const accent = assistantAccent(assistantId);
  const role = assistant?.role ? assistant.role : "assistant";
  const access = assistant ? toolAccessLabel(assistant.toolAccess) : null;
  const status =
    part.status === undefined ? null : (
      <Badge
        variant={STATUS_BADGE_VARIANT[part.status]}
        size="sm"
        data-teammate-status={part.status}
      >
        {TEAMMATE_STATUS_LABEL[part.status]}
      </Badge>
    );
  return (
    <>
      {props.joined?.includes(assistantId) ? (
        <JoinedDivider
          assistantId={assistantId}
          name={name}
          face={face}
          createdAt={props.joinedAt}
        />
      ) : null}
      <div className="flex items-start gap-2.5" data-teammate-part={part.kind}>
        {props.continues ? (
          <span aria-hidden className="size-7 shrink-0" />
        ) : (
          <AssistantAvatar assistant={face} className="mt-0.5 size-7 shrink-0" />
        )}
        <div className="flex min-w-0 max-w-[46rem] flex-1 flex-col gap-1.5">
          <MessageAuthorHeading>{name}</MessageAuthorHeading>
          {props.continues ? (
            // The name shows once per run; each message's own status still shows.
            status === null ? null : (
              <div aria-hidden>{status}</div>
            )
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1" aria-hidden>
              <b className="truncate text-sm font-semibold text-foreground">{name}</b>
              <span className="truncate text-xs text-muted-foreground">
                {access ? `${role} · ${access}` : role}
              </span>
              {status}
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
    </>
  );
}

function TeammateMessageBody({ text, files }: { text: string; files: ReadonlyArray<string> }) {
  const ctx = use(TimelineRowCtx);
  return (
    <CollapsibleMessageBody text={text}>
      <div className="text-sm leading-relaxed">
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
    </CollapsibleMessageBody>
  );
}
