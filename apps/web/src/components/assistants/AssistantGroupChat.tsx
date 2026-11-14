import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  applyAssistantGroupHistory,
  assistantGroupAuthorName,
  assistantGroupAwaitingRoute,
  assistantGroupMarkdownMentions,
  assistantGroupBoundaryLabel,
  assistantGroupFeedProjects,
  assistantGroupLatestSeq,
  assistantGroupNewSeq,
  assistantGroupRequestExpanded,
  assistantGroupRequestFeed,
  assistantGroupRunningCount,
  ASSISTANT_GROUP_ALL_PROJECTS_LABEL,
  ASSISTANT_GROUP_REQUEST_STATUS_LABEL,
  filterAssistantGroupFeed,
  type AssistantGroupChatState,
  type AssistantGroupFeedRow,
  type AssistantGroupRequestBlock,
  type AssistantGroupRequestStatus,
  assistantGroupMentionHref,
  assistantGroupMessageExcerpt,
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
  ProjectId,
} from "@t3tools/contracts";
import { assistantGroupProjectIds, splitAssistantTransferText } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CornerUpLeftIcon,
  EllipsisIcon,
  FolderIcon,
  MessageCircleQuestionMarkIcon,
  MailIcon,
  MailOpenIcon,
  PencilIcon,
  PlusIcon,
  ReplyIcon,
  SettingsIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  useAssistantEntries,
  useAssistantGroupActions,
  useAssistantGroupChat,
} from "../../state/assistants";
import { useProjects } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { WorkspaceBreadcrumb } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openAssistantDialog } from "./assistantDialogState";
import { AssistantAvatar } from "./assistantPresentation";
import {
  openAssistantGroupRoutines,
  openAssistantGroupSettings,
  openAssistantTeamDialog,
} from "./assistantTeamState";
import { GroupMessageAttachments } from "./GroupAttachments";
import {
  GroupComposer,
  MENTION_REQUIRED_COPY,
  type GroupProjectOption,
  type GroupReplyQuote,
  type GroupSendResult,
} from "./GroupComposer";
import { GroupMentionChip, type GroupMentionProject } from "./GroupMentionChip";
import { GroupTaskCard } from "./GroupTaskCard";
import { useGroupReadMarker } from "./useGroupReadMarker";
import { useAssistantTeamFlows } from "./useAssistantFlows";

const MAX_STACKED_AVATARS = 4;

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
          <MenuItem onClick={() => openAssistantGroupSettings({ environmentId, teamId: team.id })}>
            <SettingsIcon />
            Group settings
          </MenuItem>
          <MenuItem
            onClick={() => openAssistantDialog({ environmentId, preset: { teamId: team.id } })}
          >
            <PlusIcon />
            New assistant in this group
          </MenuItem>
          <MenuItem onClick={() => openAssistantGroupRoutines({ environmentId, teamId: team.id })}>
            <CalendarClockIcon />
            Group routines
          </MenuItem>
          {(team.chat?.unreadCount ?? 0) > 0 ? (
            <MenuItem disabled={!flows.canMarkRead} onClick={() => void flows.markRead(team)}>
              <MailOpenIcon />
              Mark as read
            </MenuItem>
          ) : (
            <MenuItem disabled={!flows.canMarkRead} onClick={() => void flows.markUnread(team)}>
              <MailIcon />
              Mark as unread
            </MenuItem>
          )}
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

const BUBBLE_CHIP_INK =
  "[&_[data-slot=context-chip]]:[--context-chip-ink:var(--context-chip-message,var(--context-chip-accent))]";
const ROW_CLASS = "-mx-2 flex min-w-0 rounded-xl px-2 py-1";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function Who(props: {
  readonly member: Assistant | undefined;
  readonly fallback: string;
  readonly createdAt: string;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
      <span className="truncate font-semibold text-foreground">
        {props.member?.name ?? props.fallback}
      </span>
      {props.member === undefined || props.member.role === "" ? null : (
        <span data-testid="group-role" className="max-w-32 truncate text-muted-foreground">
          {props.member.role}
        </span>
      )}
      <time dateTime={props.createdAt} className="shrink-0 text-muted-foreground/70 tabular-nums">
        {timeFormat.format(new Date(props.createdAt))}
      </time>
    </div>
  );
}

/** The message a reply answers, as one quoted line that leads back to it. */
function ReplyLine(props: {
  readonly target: AssistantGroupMessage;
  readonly author: string;
  readonly onJump: (messageId: AssistantGroupMessage["id"]) => void;
}) {
  return (
    <button
      type="button"
      data-testid="group-reply-quote"
      className="flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:bg-foreground/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={() => props.onJump(props.target.id)}
    >
      <CornerUpLeftIcon aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">In reply to </span>
      <span className="max-w-[50%] shrink-0 truncate font-medium">{props.author}</span>{" "}
      <span className="min-w-0 truncate">{assistantGroupMessageExcerpt(props.target.text)}</span>
    </button>
  );
}

function NewDivider() {
  return (
    <div
      role="separator"
      aria-label="New messages"
      data-testid="group-new-divider"
      className="flex items-center gap-2 text-xs font-medium text-info-foreground"
    >
      <span aria-hidden className="h-px flex-1 bg-info/40" />
      New
      <span aria-hidden className="h-px flex-1 bg-info/40" />
    </div>
  );
}

function WaitingNotice(props: {
  readonly message: AssistantGroupMessage;
  readonly waiting: NonNullable<AssistantGroupMessage["waiting"]>;
  readonly author: string;
  readonly onOpenThread: (threadId: AssistantGroupTask["threadId"]) => void;
  readonly onOpenDecision: () => void;
}) {
  const { waiting } = props;
  const [question = "", ...context] = props.message.text.trim().split("\n");
  return (
    <div
      data-testid="group-waiting"
      data-message-id={props.message.id}
      data-resolved={waiting.resolved || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl border px-3.5 py-3",
        waiting.resolved
          ? "border-foreground/10 text-muted-foreground"
          : "border-warning/40 bg-warning/6",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        {waiting.resolved ? (
          <CircleCheckIcon aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <MessageCircleQuestionMarkIcon
            aria-hidden
            className="size-3.5 shrink-0 text-warning-foreground"
          />
        )}
        <span
          className={cn(
            "min-w-0 truncate font-medium",
            !waiting.resolved && "text-warning-foreground",
          )}
        >
          {props.author} {waiting.resolved ? "asked" : "is waiting on you"}
        </span>
        {waiting.resolved ? <span className="ms-auto shrink-0">Resolved</span> : null}
      </div>
      <p
        className={cn(
          "text-sm wrap-anywhere",
          waiting.resolved ? "text-muted-foreground" : "font-medium text-foreground",
        )}
      >
        {question}
      </p>
      {context.length === 0 ? null : (
        <p className="text-xs whitespace-pre-wrap wrap-anywhere text-muted-foreground">
          {context.join("\n").trim()}
        </p>
      )}
      {waiting.resolved ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={() => props.onOpenThread(waiting.threadId)}>
            <SquareArrowOutUpRightIcon />
            Open conversation
          </Button>
          {waiting.decisionId === undefined ? null : (
            <Button size="xs" variant="outline" onClick={props.onOpenDecision}>
              <MessageCircleQuestionMarkIcon />
              Open decision
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function FeedRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: AssistantGroupFeedRow;
  readonly chat: AssistantGroupChatState;
  readonly assistants: ReadonlyMap<string, Assistant>;
  readonly members: ReadonlyArray<Assistant>;
  readonly projects: ReadonlyArray<GroupMentionProject>;
  readonly lead: Assistant | undefined;
  readonly canAct: boolean;
  readonly archived: boolean;
  readonly onReply: (message: AssistantGroupMessage, name: string) => void;
  readonly onJump: (messageId: AssistantGroupMessage["id"]) => void;
  readonly onTaskAction: (
    task: AssistantGroupTask,
    action: AssistantGroupTaskAction,
    ownerId?: Assistant["id"],
  ) => void;
  readonly onOpenConversation: (task: AssistantGroupTask) => void;
  readonly onOpenThread: (threadId: AssistantGroupTask["threadId"]) => void;
  readonly onOpenDecision: () => void;
}) {
  const { message } = props.row;
  const author =
    message.assistantId === null ? undefined : props.assistants.get(message.assistantId);
  const markdown = (text: string) => (
    <ChatMarkdown
      text={assistantGroupMarkdownMentions(text, props.members, props.projects)}
      cwd={undefined}
      environmentId={props.environmentId}
      className="wrap-anywhere"
      renderMention={(href, text) => (
        <GroupMentionChip
          kind={assistantGroupMentionHref(href)?.kind ?? "member"}
          value={assistantGroupMentionHref(href)?.value ?? text.slice(1)}
          members={props.members}
          projects={props.projects}
          environmentId={props.environmentId}
        />
      )}
    />
  );
  const replyTarget =
    message.replyToMessageId === null
      ? undefined
      : props.chat.messages.get(message.replyToMessageId);
  const replyLine =
    replyTarget === undefined ? null : (
      <ReplyLine
        target={replyTarget}
        author={assistantGroupAuthorName(replyTarget, (id) => props.assistants.get(id)?.name)}
        onJump={props.onJump}
      />
    );
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
  if (props.row.role === "boundary") {
    return (
      <div
        role="separator"
        aria-label={assistantGroupBoundaryLabel(message)}
        data-testid="group-boundary"
        className="flex items-center gap-2 text-xs font-medium text-muted-foreground"
      >
        <span aria-hidden className="h-px flex-1 bg-foreground/12" />
        {assistantGroupBoundaryLabel(message)}
        <span aria-hidden className="h-px flex-1 bg-foreground/12" />
      </div>
    );
  }
  if (props.row.role === "note" && message.waiting !== undefined) {
    return (
      <WaitingNotice
        message={message}
        waiting={message.waiting}
        author={author?.name ?? "Assistant"}
        onOpenThread={props.onOpenThread}
        onOpenDecision={props.onOpenDecision}
      />
    );
  }
  if (props.row.role === "note") {
    return (
      <div
        data-testid="group-note"
        data-message-id={message.id}
        className="flex flex-col items-center gap-1.5 rounded-xl py-0.5"
      >
        <p className="text-center text-xs text-muted-foreground">{message.text}</p>
        {cards.length > 0 ? <div className="w-full max-w-md">{cards}</div> : null}
      </div>
    );
  }
  if (props.row.role === "request") {
    const fromUser = message.author === "user";
    const parts = splitAssistantTransferText(message.text);
    const label =
      message.authorLabel ?? author?.name ?? (message.author === "routine" ? "Schedule" : "Agent");
    return (
      <div
        data-testid="group-request"
        data-message-id={message.id}
        className={cn(ROW_CLASS, "flex-col gap-1", fromUser ? "items-end" : "items-start")}
      >
        {fromUser ? null : (
          <span className="px-1 text-xs font-semibold text-muted-foreground">{label}</span>
        )}
        {replyLine}
        <div
          className={cn(
            "min-w-0 max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm text-message-foreground @xl/group-chat:max-w-[75%]",
            fromUser ? "bg-message" : "bg-foreground/6",
            BUBBLE_CHIP_INK,
          )}
        >
          {parts.body === "" ? null : markdown(parts.body)}
          {parts.files === null ? null : (
            <div data-testid="group-request-files" className="mt-1.5">
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
          <p data-testid="group-routing" className="px-1 text-xs text-muted-foreground">
            {props.lead === undefined
              ? "Waiting for a lead to route it. Set one in Edit group."
              : `${props.lead.name} (lead) is choosing who answers…`}
          </p>
        ) : null}
        {cards.length > 0 ? <div className="w-full max-w-md self-stretch">{cards}</div> : null}
      </div>
    );
  }
  const name = author?.name ?? "Assistant";
  return (
    <div
      data-testid="group-answer"
      data-message-id={message.id}
      className={cn(ROW_CLASS, "group/answer items-start gap-2.5")}
    >
      {author === undefined ? (
        <span className="size-7 shrink-0" />
      ) : (
        <AssistantAvatar
          assistant={author}
          environmentId={props.environmentId}
          className="mt-0.5 size-7"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Who member={author} fallback={name} createdAt={message.createdAt} />
        {replyLine === null ? null : <div className="-ms-1.5">{replyLine}</div>}
        <div className="text-sm leading-relaxed">{markdown(message.text)}</div>
        <div className="-ms-1.5">
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

const STATUS_TONE: Record<AssistantGroupRequestStatus, string> = {
  routing: "text-muted-foreground",
  "needs-project": "text-warning-foreground",
  working: "text-info-foreground",
  "needs-you": "text-warning-foreground",
  done: "text-success-foreground",
  cancelled: "text-muted-foreground",
};

/** A request with its messages and cards, folded to its header when the user closes it. */
function RequestBlock(props: {
  readonly block: AssistantGroupRequestBlock;
  readonly projectName: string | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly projects: ReadonlyArray<GroupProjectOption>;
  readonly canPick: boolean;
  readonly onPickProject: (project: GroupProjectOption) => void;
  readonly onReply: () => void;
  readonly children: ReactNode;
}) {
  const { block } = props;
  return (
    <section
      data-testid="group-request-block"
      aria-label={block.title}
      className="flex min-w-0 flex-col rounded-xl border border-foreground/10"
    >
      <button
        type="button"
        aria-expanded={props.expanded}
        data-testid="group-request-header"
        className="flex min-w-0 cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-left outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={props.onToggle}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
            props.expanded && "rotate-90",
          )}
        />
        <span
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          data-testid="group-request-title"
        >
          {block.title}
        </span>
        {props.projectName === null ? null : (
          <span className="flex max-w-36 min-w-0 shrink items-center gap-1 text-xs text-muted-foreground @max-sm/group-chat:hidden">
            <FolderIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate" data-testid="group-request-project">
              {props.projectName}
            </span>
          </span>
        )}
        <span
          data-testid="group-request-status"
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-xs font-medium",
            STATUS_TONE[block.status],
          )}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {ASSISTANT_GROUP_REQUEST_STATUS_LABEL[block.status]}
        </span>
      </button>
      {props.expanded ? (
        <div className="flex min-w-0 flex-col gap-3 border-t border-foreground/10 px-3 py-3">
          {props.children}
          {block.status === "needs-project" && props.projects.length > 0 ? (
            <div
              role="group"
              aria-label="Pick a project"
              data-testid="group-request-projects"
              className="flex flex-wrap items-center gap-1.5"
            >
              <span className="me-0.5 text-xs text-muted-foreground">Run it in</span>
              {props.projects.map((project) => (
                <Button
                  key={project.id}
                  size="xs"
                  variant="outline"
                  disabled={!props.canPick}
                  onClick={() => props.onPickProject(project)}
                >
                  <FolderIcon />
                  {project.label}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="-ms-1.5">
            <Button
              size="micro"
              variant="ghost-muted"
              disabled={!props.canPick}
              aria-label={`Reply to request ${block.title}`}
              onClick={props.onReply}
            >
              <ReplyIcon />
              Reply to request
            </Button>
          </div>
        </div>
      ) : null}
    </section>
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
    readonly projectId: ProjectId | null;
    readonly quote: GroupReplyQuote;
  } | null>(null);
  const [projectFilter, setProjectFilter] = useState<ProjectId | null>(null);
  const [composerProject, setComposerProject] = useState<ProjectId | null>(null);
  // The user's own open or closed choice per request; the rest follow assistantGroupRequestExpanded.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const projects = useProjects();
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const anchor = useRef<{ readonly height: number; readonly top: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Where the "New" line goes, fixed when the chat first shows: it stays until the user leaves.
  const [newSeq, setNewSeq] = useState<number | null | undefined>(undefined);
  const scrolledToNew = useRef(false);
  // A message to bring into view and flash once the render that shows it lands.
  const jumpTarget = useRef<string | null>(null);
  const [, setJumps] = useState(0);

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
  const feed = chat === null ? [] : assistantGroupRequestFeed(chat);
  const projectName = (id: ProjectId) =>
    projects.find((project) => project.environmentId === environmentId && project.id === id)
      ?.title ?? "Unknown project";
  const feedProjects = assistantGroupFeedProjects(feed);
  // A filter on a project no longer in the feed would hide everything with no way to see why.
  const activeFilter =
    projectFilter !== null && feedProjects.includes(projectFilter) ? projectFilter : null;
  const items = filterAssistantGroupFeed(feed, activeFilter);
  const newestRequest = items.findLast((item) => item.kind === "request");
  const groupProjects: ReadonlyArray<GroupProjectOption> = assistantGroupProjectIds(
    members,
    team?.projectIds ?? [],
  ).map((id) => ({ id, label: projectName(id) }));
  const mentionProjects: ReadonlyArray<GroupMentionProject> = groupProjects.map((project) => ({
    id: project.id,
    name: project.label,
  }));
  const sentByUser =
    chat === null
      ? []
      : [...chat.messages.values()]
          .filter((message) => message.author === "user" && message.kind === "message")
          .sort((left, right) => left.seq - right.seq)
          .map((message) => ({ id: message.id, text: message.text }));
  // The filter may name a project the group's members do not work in; then the lead decides.
  const groupComposerProject = groupProjects.some((project) => project.id === composerProject)
    ? composerProject
    : null;
  const archived = team?.archivedAt != null;
  // Read position when the chat opened: blocks with unread messages stay open while they are read.
  const [readAtOpen, setReadAtOpen] = useState<number | null>(null);
  if (newSeq === undefined && chat !== null && team !== undefined) {
    // A server without counters sends none: there is no position to draw a line from.
    setNewSeq(team.chat === undefined ? null : assistantGroupNewSeq(chat, team.chat.readSeq));
    setReadAtOpen(team.chat?.readSeq ?? null);
  }
  useGroupReadMarker({
    latestSeq: chat === null ? null : assistantGroupLatestSeq(chat),
    readSeq: team?.chat?.readSeq ?? 0,
    atBottom,
    enabled: team?.chat !== undefined && actions.canMarkRead,
    markRead: (readSeq) => void actions.markRead(teamId, { readSeq }),
  });

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
    if (jumpTarget.current !== null) {
      const target = element.querySelector(`[data-message-id="${CSS.escape(jumpTarget.current)}"]`);
      jumpTarget.current = null;
      if (target instanceof HTMLElement) {
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
        target.animate(
          [
            { backgroundColor: "color-mix(in srgb, var(--primary) 14%, transparent)" },
            { backgroundColor: "transparent" },
          ],
          { duration: 1200, easing: "ease-out" },
        );
      }
    }
    // Open on the first unread message when it is above the fold, else stay at the end.
    const divider = element.querySelector("[data-testid=group-new-divider]");
    if (divider !== null && !scrolledToNew.current) {
      scrolledToNew.current = true;
      const gap = divider.getBoundingClientRect().top - element.getBoundingClientRect().top;
      if (gap < 0) {
        element.scrollTop += gap - 12;
        stickToBottom.current = false;
      }
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
      // A reply stays in its request's project; only a request with none can be given one.
      ...(groupComposerProject === null || replyTo?.projectId != null
        ? {}
        : { projectId: groupComposerProject }),
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

  const pickProject = async (block: AssistantGroupRequestBlock, project: GroupProjectOption) => {
    const reply = await actions.post({
      teamId,
      text: project.label,
      replyToMessageId: block.requestId,
      projectId: project.id,
    });
    if (!reply.ok) failed("Could not set the project", reply.message);
    else stickToBottom.current = true;
  };

  /** Brings a message into view, opening its request and clearing a filter that hides it. */
  const jumpTo = (messageId: AssistantGroupMessage["id"]) => {
    const holder = feed.find(
      (item) =>
        item.kind === "request" &&
        (item.block.requestId === messageId ||
          item.block.rows.some((row) => row.message.id === messageId)),
    );
    if (holder?.kind === "request") {
      setToggled((current) => new Map(current).set(holder.block.requestId, true));
      if (activeFilter !== null && holder.block.projectId !== activeFilter) setProjectFilter(null);
    }
    stickToBottom.current = false;
    jumpTarget.current = messageId;
    setJumps((count) => count + 1);
  };

  const openThread = (threadId: AssistantGroupTask["threadId"]) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });

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
    const feedRow = (state: AssistantGroupChatState, row: AssistantGroupFeedRow) => (
      <Fragment key={row.message.id}>
        {row.message.seq === newSeq ? <NewDivider /> : null}
        <FeedRow
          environmentId={environmentId}
          row={row}
          chat={state}
          assistants={byId}
          members={members}
          projects={mentionProjects}
          lead={lead}
          canAct={actions.canAct}
          archived={archived}
          onJump={jumpTo}
          onReply={(message, name) => {
            const requestId = message.requestId;
            const root =
              requestId === undefined
                ? undefined
                : (state.messages.get(requestId) ?? state.requests.get(requestId));
            const projectId = root?.projectId ?? null;
            setReplyTo({
              id: message.id,
              projectId,
              quote: {
                label: `Replying to ${name}`,
                excerpt: assistantGroupMessageExcerpt(message.text),
                to: name,
                projectLabel: projectId === null ? null : projectName(projectId),
              },
            });
          }}
          onTaskAction={(task, action, ownerId) => void taskAction(task, action, ownerId)}
          onOpenConversation={(task) => openThread(task.threadId)}
          onOpenThread={openThread}
          onOpenDecision={() => void navigate({ to: "/activity" })}
        />
      </Fragment>
    );
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
        {feedProjects.length < 2 ? null : (
          <div
            data-glass-layer
            className="flex shrink-0 items-center gap-2 border-b border-foreground/12 px-3 py-1 text-xs @xl/group-chat:px-6"
          >
            <span aria-hidden className="text-muted-foreground">
              Show
            </span>
            <Select
              modal={false}
              value={activeFilter ?? ""}
              items={[
                { value: "", label: ASSISTANT_GROUP_ALL_PROJECTS_LABEL },
                ...feedProjects.map((id) => ({ value: id as string, label: projectName(id) })),
              ]}
              onValueChange={(value: string | null) => {
                const next = value === null || value === "" ? null : (value as ProjectId);
                setProjectFilter(next);
                setComposerProject(next);
              }}
            >
              <SelectTrigger size="xs" variant="ghost" aria-label="Filter by project">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="">{ASSISTANT_GROUP_ALL_PROJECTS_LABEL}</SelectItem>
                {feedProjects.map((id) => (
                  <SelectItem key={id} value={id}>
                    {projectName(id)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        )}
        <div
          ref={scroller}
          data-testid="group-feed"
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-none"
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 48;
            setAtBottom(stickToBottom.current);
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
            {chat !== null && feed.length === 0 ? (
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
              : items.map((item) => {
                  if (item.kind === "row") return feedRow(chat, item.row);
                  const { block } = item;
                  const expanded =
                    toggled.get(block.requestId) ??
                    assistantGroupRequestExpanded(
                      block,
                      readAtOpen ?? Number.MAX_SAFE_INTEGER,
                      item === newestRequest,
                    );
                  return (
                    <RequestBlock
                      key={block.requestId}
                      block={block}
                      projectName={block.projectId === null ? null : projectName(block.projectId)}
                      expanded={expanded}
                      onToggle={() =>
                        setToggled((current) => new Map(current).set(block.requestId, !expanded))
                      }
                      projects={groupProjects}
                      canPick={!archived && actions.canPost}
                      onPickProject={(project) => void pickProject(block, project)}
                      onReply={() =>
                        setReplyTo({
                          id: block.requestId,
                          projectId: block.projectId,
                          quote: {
                            label: `Replying to request: ${block.title}`,
                            excerpt: "",
                            to: null,
                            projectLabel:
                              block.projectId === null ? null : projectName(block.projectId),
                          },
                        })
                      }
                    >
                      {block.rows.map((row) => feedRow(chat, row))}
                    </RequestBlock>
                  );
                })}
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
          projects={groupProjects}
          projectId={groupComposerProject}
          onProjectChange={setComposerProject}
          replyingTo={replyTo?.quote ?? null}
          onJumpToReply={() => replyTo !== null && jumpTo(replyTo.id)}
          onClearReply={() => setReplyTo(null)}
          history={sentByUser}
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
