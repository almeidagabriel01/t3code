import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  applyAssistantGroupHistory,
  assistantGroupAuthorName,
  assistantGroupAwaitingRoute,
  assistantGroupFeed,
  assistantGroupRunningCount,
  type AssistantGroupChatState,
  type AssistantGroupFeedRow,
} from "@t3tools/client-runtime/assistantGroupChat";
import { teamSummary } from "@t3tools/client-runtime/assistantTeam";
import type {
  Assistant,
  AssistantGroupMessage,
  AssistantGroupsHistoryResult,
  AssistantGroupTask,
  AssistantGroupTaskAction,
  AssistantTeam,
  AssistantTeamId,
  ChatAttachment,
  EnvironmentId,
} from "@t3tools/contracts";
import { splitAssistantTransferText } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CalendarClockIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  ReplyIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  useAssistantEntries,
  useAssistantGroupActions,
  useAssistantGroupChat,
} from "../../state/assistants";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { WorkspaceBreadcrumb } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openAssistantDialog } from "./assistantDialogState";
import { AssistantAvatar } from "./assistantPresentation";
import { openAssistantTeamDialog } from "./assistantTeamState";
import { GroupMessageAttachments } from "./GroupAttachments";
import { GroupComposer, MENTION_REQUIRED_COPY, type GroupSendResult } from "./GroupComposer";
import { GroupTaskCard } from "./GroupTaskCard";
import { useAssistantTeamFlows } from "./useAssistantFlows";

const MENTION_TOKEN = /(@[\p{L}\p{N}_-]+)/u;
const MAX_STACKED_AVATARS = 4;

/** The text with each `@mention` picked out, as the user typed it. */
function MentionText(props: { readonly text: string }) {
  let offset = 0;
  return props.text.split(MENTION_TOKEN).map((part, index) => {
    const key = offset;
    offset += part.length;
    return index % 2 === 1 ? (
      <span key={key} className="font-semibold text-primary">
        {part}
      </span>
    ) : (
      <span key={key}>{part}</span>
    );
  });
}

function failed(title: string, message: string) {
  toastManager.add({ type: "error", title, description: message });
}

function GroupHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam;
  readonly members: ReadonlyArray<Assistant>;
  readonly allAssistants: ReadonlyArray<Assistant>;
  readonly running: number;
}) {
  const { environmentId, team } = props;
  const navigate = useNavigate();
  const flows = useAssistantTeamFlows(environmentId);
  const archived = team.archivedAt !== null;
  const shown = props.members.slice(0, MAX_STACKED_AVATARS);
  return (
    <WorkspacePageHeader electron={isElectron} className="relative bg-background" data-glass-layer>
      <WorkspaceBreadcrumb ariaLabel="Group chat" className="flex-1">
        <li className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 items-center" data-testid="group-avatars">
            {shown.map((member) => (
              <AssistantAvatar
                key={member.id}
                assistant={member}
                environmentId={environmentId}
                className="-ms-1.5 size-5 first:ms-0"
              />
            ))}
          </span>
          <h1 className="min-w-0 truncate font-medium">{team.name}</h1>
          <span className="truncate text-xs font-normal text-muted-foreground @max-lg/group-chat:hidden">
            · {teamSummary(team, props.allAssistants)}
          </span>
          {props.running > 0 ? (
            <Badge variant="info" size="sm" data-testid="group-running">
              {props.running} running
            </Badge>
          ) : null}
        </li>
      </WorkspaceBreadcrumb>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`${team.name} actions`}
                  />
                }
              />
            }
          >
            <EllipsisIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{team.name} actions</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          <MenuItem onClick={() => openAssistantTeamDialog({ environmentId, teamId: team.id })}>
            <PencilIcon />
            Edit group
          </MenuItem>
          <MenuItem
            onClick={() => openAssistantDialog({ environmentId, preset: { teamId: team.id } })}
          >
            <PlusIcon />
            New assistant in this group
          </MenuItem>
          <MenuItem
            onClick={() =>
              void navigate({
                to: "/settings/scheduled-tasks",
                search: { environmentId, assistantTeamId: team.id },
              })
            }
          >
            <CalendarClockIcon />
            Schedule in this group
          </MenuItem>
          <MenuSeparator />
          {archived ? (
            <MenuItem disabled={!flows.canAct} onClick={() => void flows.restore(team)}>
              <ArchiveRestoreIcon />
              Restore group
            </MenuItem>
          ) : (
            <MenuItem disabled={!flows.canAct} onClick={() => void flows.archive(team)}>
              <ArchiveIcon />
              Archive group
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </WorkspacePageHeader>
  );
}

function Who(props: {
  readonly member: Assistant | undefined;
  readonly fallback: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-semibold">
      <span className="truncate">{props.member?.name ?? props.fallback}</span>
      {props.member === undefined || props.member.role === "" ? null : (
        <Badge variant="outline" size="sm" data-testid="group-role">
          <span className="max-w-24 truncate">{props.member.role}</span>
        </Badge>
      )}
      {props.children}
    </div>
  );
}

/** The member a request answers, when it was sent with Reply. */
function repliedToName(
  message: AssistantGroupMessage,
  chat: AssistantGroupChatState,
  assistants: ReadonlyMap<string, Assistant>,
): string | undefined {
  if (message.replyToMessageId === null) return undefined;
  const target = chat.messages.get(message.replyToMessageId);
  return target?.assistantId == null ? undefined : assistants.get(target.assistantId)?.name;
}

function FeedRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: AssistantGroupFeedRow;
  readonly chat: AssistantGroupChatState;
  readonly assistants: ReadonlyMap<string, Assistant>;
  readonly members: ReadonlyArray<Assistant>;
  readonly lead: Assistant | undefined;
  readonly canAct: boolean;
  readonly archived: boolean;
  readonly onReply: (message: AssistantGroupMessage, name: string) => void;
  readonly onTaskAction: (
    task: AssistantGroupTask,
    action: AssistantGroupTaskAction,
    ownerId?: Assistant["id"],
  ) => void;
  readonly onOpenConversation: (task: AssistantGroupTask) => void;
}) {
  const { message } = props.row;
  const author =
    message.assistantId === null ? undefined : props.assistants.get(message.assistantId);
  const cards = props.row.tasks.map((task) => (
    <GroupTaskCard
      key={task.id}
      task={task}
      environmentId={props.environmentId}
      owner={props.row.role === "answer" ? undefined : props.assistants.get(task.ownerId)}
      reassignTo={props.members.filter((member) => member.id !== task.ownerId)}
      canAct={props.canAct}
      onAction={(action, ownerId) => props.onTaskAction(task, action, ownerId)}
      onOpenConversation={() => props.onOpenConversation(task)}
    />
  ));
  if (props.row.role === "note") {
    return (
      <div data-testid="group-note" className="flex flex-col items-center gap-1">
        <p className="text-center text-xs text-muted-foreground">{message.text}</p>
        {cards.length > 0 ? <div className="w-full max-w-md">{cards}</div> : null}
      </div>
    );
  }
  if (props.row.role === "request") {
    const fromUser = message.author === "user";
    const parts = splitAssistantTransferText(message.text);
    const repliedTo = repliedToName(message, props.chat, props.assistants);
    const label =
      message.authorLabel ?? author?.name ?? (message.author === "routine" ? "Schedule" : "Agent");
    return (
      <div
        data-testid="group-request"
        className={cn("flex min-w-0 flex-col gap-1", fromUser ? "items-end" : "items-start")}
      >
        {fromUser ? null : <span className="text-xs text-muted-foreground">{label}</span>}
        {repliedTo === undefined ? null : (
          <span className="text-xs text-muted-foreground">Reply to {repliedTo}</span>
        )}
        <div className="max-w-[85%] rounded-2xl bg-primary/12 px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere @xl/group-chat:max-w-[70%]">
          <MentionText text={parts.body} />
          {parts.files === null ? null : (
            <div data-testid="group-request-files" className="mt-1.5 whitespace-normal">
              <ChatMarkdown
                text={parts.files}
                cwd={undefined}
                environmentId={props.environmentId}
                className="wrap-anywhere"
              />
            </div>
          )}
        </div>
        <GroupMessageAttachments
          environmentId={props.environmentId}
          attachments={message.attachments ?? []}
          align={fromUser ? "end" : "start"}
        />
        {assistantGroupAwaitingRoute(props.chat, message) ? (
          <p data-testid="group-routing" className="text-xs text-muted-foreground">
            {props.lead === undefined
              ? "Waiting for someone to take it…"
              : `${props.lead.name} (lead) is choosing who answers…`}
          </p>
        ) : null}
        {cards.length > 0 ? <div className="w-full max-w-md">{cards}</div> : null}
      </div>
    );
  }
  const replyTarget =
    message.replyToMessageId === null
      ? undefined
      : props.chat.messages.get(message.replyToMessageId);
  const name = author?.name ?? "Assistant";
  return (
    <div data-testid="group-answer" className="flex min-w-0 items-start gap-2.5">
      {author === undefined ? (
        <span className="size-7 shrink-0" />
      ) : (
        <AssistantAvatar
          assistant={author}
          environmentId={props.environmentId}
          className="size-7"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Who member={author} fallback={name} />
        {replyTarget === undefined ? null : (
          <p className="truncate text-xs text-muted-foreground">
            In reply to{" "}
            {assistantGroupAuthorName(replyTarget, (id) => props.assistants.get(id)?.name)}
          </p>
        )}
        <div className="text-sm leading-relaxed">
          <ChatMarkdown
            text={message.text}
            cwd={undefined}
            environmentId={props.environmentId}
            className="wrap-anywhere"
          />
        </div>
        <div>
          <Button
            size="micro"
            variant="ghost-muted"
            disabled={props.archived}
            aria-label={`Reply to ${name}`}
            onClick={() => props.onReply(message, name)}
          >
            <ReplyIcon />
            Reply
          </Button>
        </div>
        {cards}
      </div>
    </div>
  );
}

/** One group's chat, as in a channel: requests, each member's answers and the tasks between. */
export function AssistantGroupChat(props: {
  readonly environmentId: EnvironmentId;
  readonly teamId: AssistantTeamId;
}) {
  const { environmentId, teamId } = props;
  const entries = useAssistantEntries();
  const live = useAssistantGroupChat(environmentId, teamId);
  const actions = useAssistantGroupActions(environmentId);
  const flows = useAssistantTeamFlows(environmentId);
  const navigate = useNavigate();
  const [pages, setPages] = useState<ReadonlyArray<AssistantGroupsHistoryResult>>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [replyTo, setReplyTo] = useState<{
    readonly id: AssistantGroupMessage["id"];
    readonly name: string;
  } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const anchor = useRef<{ readonly height: number; readonly top: number } | null>(null);

  const team = entries.teams.find(
    (entry) => entry.environmentId === environmentId && entry.team.id === teamId,
  )?.team;
  const everyone = [...entries.active, ...entries.archived]
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.assistant);
  const byId = new Map<string, Assistant>(everyone.map((assistant) => [assistant.id, assistant]));
  const members = (team?.memberIds ?? []).flatMap((id) => {
    const member = byId.get(id);
    return member === undefined || member.archivedAt !== null ? [] : [member];
  });
  const chat =
    live === null
      ? null
      : pages.reduce((state, page) => applyAssistantGroupHistory(state, page), live);
  const rows = chat === null ? [] : assistantGroupFeed(chat);
  const archived = team?.archivedAt != null;

  // The feed follows new messages only while the user is at its end, and holds still while
  // an older page is added above, so what they were reading does not jump.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scroll position is DOM state
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    if (anchor.current !== null) {
      element.scrollTop = element.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
    } else if (stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  });

  const loadOlder = async () => {
    if (chat === null || !chat.hasMore || loadingOlder) return;
    const element = scroller.current;
    setLoadingOlder(true);
    const reply = await actions.olderThan(teamId, chat);
    setLoadingOlder(false);
    if (!reply.ok) return failed("Could not load earlier messages", reply.message);
    if (element !== null) anchor.current = { height: element.scrollHeight, top: element.scrollTop };
    setPages((current) => [...current, reply.value]);
  };

  const send = async (
    text: string,
    attachments: ReadonlyArray<ChatAttachment>,
  ): Promise<GroupSendResult> => {
    const reply = await actions.post({
      teamId,
      text,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(replyTo === null ? {} : { replyToMessageId: replyTo.id }),
    });
    if (reply.ok) {
      stickToBottom.current = true;
      setReplyTo(null);
      return { ok: true };
    }
    return {
      ok: false,
      message:
        reply.reason === "mention_required"
          ? MENTION_REQUIRED_COPY
          : reply.reason === "archived"
            ? "This group is archived. Restore it to write here."
            : reply.message,
    };
  };

  const taskAction = async (
    task: AssistantGroupTask,
    action: AssistantGroupTaskAction,
    ownerId?: Assistant["id"],
  ) => {
    const reply = await actions.taskAction({
      taskId: task.id,
      action,
      ...(ownerId === undefined ? {} : { ownerId }),
    });
    if (!reply.ok) failed("Could not update the task", reply.message);
  };

  const body = () => {
    if (team === undefined) {
      return entries.environmentIds.includes(environmentId) ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Group not found</EmptyTitle>
            <EmptyDescription>It may have been deleted.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="min-h-0 flex-1" />
      );
    }
    const lead = members.find((member) => member.id === team.leadId);
    return (
      <>
        {archived ? (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-foreground/12 bg-foreground/4 px-3 py-1.5 text-xs @xl/group-chat:px-6"
          >
            <ArchiveIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Archived · no new messages</span>
            <Button
              size="xs"
              variant="outline"
              disabled={!flows.canAct}
              onClick={() => void flows.restore(team)}
            >
              <ArchiveRestoreIcon />
              Restore
            </Button>
          </div>
        ) : null}
        <div
          ref={scroller}
          data-testid="group-feed"
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-none"
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 48;
            if (element.scrollTop < 48) void loadOlder();
          }}
        >
          <div className="flex min-h-full flex-col justify-end gap-3 px-3 py-4 @xl/group-chat:px-6">
            {chat?.hasMore ? (
              <Button
                size="xs"
                variant="ghost-muted"
                className="self-center"
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
              >
                Load earlier messages
              </Button>
            ) : null}
            {chat !== null && rows.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No messages yet</EmptyTitle>
                  <EmptyDescription>
                    {members.length === 0
                      ? "Add assistants to this group in Edit group, then write here."
                      : `${members.map((member) => member.name).join(", ")} ${members.length === 1 ? "is" : "are"} in this group. Start with @${members[0]!.handle} to give one a task, @everyone for all of them${lead === undefined ? "" : `, or write without @ and ${lead.name} routes it`}.`}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {chat === null
              ? null
              : rows.map((row) => (
                  <FeedRow
                    key={row.message.id}
                    environmentId={environmentId}
                    row={row}
                    chat={chat}
                    assistants={byId}
                    members={members}
                    lead={lead}
                    canAct={actions.canAct}
                    archived={archived}
                    onReply={(message, name) => setReplyTo({ id: message.id, name })}
                    onTaskAction={(task, action, ownerId) => void taskAction(task, action, ownerId)}
                    onOpenConversation={(task) =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(
                          scopeThreadRef(environmentId, task.threadId),
                        ),
                      })
                    }
                  />
                ))}
          </div>
        </div>
        <GroupComposer
          key={`${environmentId}:${team.id}`}
          draftKey={`${environmentId}:${team.id}`}
          environmentId={environmentId}
          members={members}
          leadId={team.leadId}
          disabled={archived || !actions.canPost}
          disabledReason={archived ? "Restore the group to write here" : null}
          replyingTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          onSend={send}
        />
      </>
    );
  };

  return (
    <SidebarInset className="@container/group-chat h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {team === undefined ? (
        <WorkspacePageHeader
          electron={isElectron}
          className="relative bg-background"
          data-glass-layer
        >
          <WorkspaceBreadcrumb ariaLabel="Group chat">
            <li className="truncate text-sm font-medium">Group chat</li>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
      ) : (
        <GroupHeader
          environmentId={environmentId}
          team={team}
          members={members}
          allAssistants={everyone}
          running={chat === null ? 0 : assistantGroupRunningCount(chat)}
        />
      )}
      {body()}
    </SidebarInset>
  );
}
