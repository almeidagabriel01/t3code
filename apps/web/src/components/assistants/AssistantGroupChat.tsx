import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  applyAssistantGroupHistory,
  assistantGroupActivity,
  assistantGroupAnswerRoot,
  assistantGroupAuthorName,
  assistantGroupAwaitingRoute,
  assistantGroupMarkdownMentions,
  assistantGroupBoundaryLabel,
  assistantGroupInScope,
  assistantGroupLatestSeq,
  assistantGroupNewSeq,
  assistantGroupAllReadSeq,
  assistantGroupRequestExpanded,
  assistantGroupRequestFeed,
  assistantGroupRequestProject,
  assistantGroupRunningCount,
  assistantGroupMemberWork,
  assistantGroupRequestOwners,
  assistantGroupTaskTree,
  ASSISTANT_GROUP_TASK_MOOD,
  ASSISTANT_GROUP_STATUS_LABEL,
  type AssistantGroupMemberWork,
  assistantGroupTabAfterSend,
  assistantGroupLandedPick,
  assistantGroupComposerProjects,
  assistantGroupComposerProject,
  assistantGroupProjectLabel,
  type AssistantGroupProjectPick,
  type AssistantGroupTabPick,
  assistantGroupTabPick,
  assistantGroupTabView,
  ASSISTANT_GROUP_REQUEST_STATUS_LABEL,
  type AssistantGroupChatState,
  type AssistantGroupFeedRow,
  type AssistantGroupRequestBlock,
  type AssistantGroupRequestStatus,
  type AssistantGroupTab,
  type AssistantGroupTabKey,
  assistantGroupMentionHref,
  assistantGroupMessageExcerpt,
  assistantGroupWorkedLabel,
  assistantGroupWaitingRequests,
  assistantGroupWaitingWhy,
  type AssistantGroupWaitingItem,
} from "@t3tools/client-runtime/assistantGroupChat";
import { folderIndicatorDetail } from "@t3tools/client-runtime/sidebarZones";
import { teamSummary } from "@t3tools/client-runtime/assistantTeam";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
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
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import {
  ASSISTANT_GROUP_WORKING_TASK_STATUSES,
  assistantGroupInstructionBody,
  assistantGroupProjectIds,
  splitAssistantTransferText,
} from "@t3tools/contracts";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatModelSlugName } from "@t3tools/shared/model";
import { teamModelLayer } from "@t3tools/shared/modelSelectionPrecedence";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BoxIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CornerUpLeftIcon,
  EllipsisIcon,
  FolderCogIcon,
  FolderIcon,
  HashIcon,
  MessageCircleQuestionMarkIcon,
  MailIcon,
  MailOpenIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  ReplyIcon,
  SettingsIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { groupTabStorageKey, SavedGroupTab } from "./groupTabStorage";
import { useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import {
  useAssistantEntries,
  useAssistantGroupActions,
  useAssistantGroupChat,
  useShowGroupTab,
} from "../../state/assistants";
import { useProject, useProjects, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { ProjectFavicon } from "../ProjectFavicon";
import { CollapsibleMessageBody } from "../chat/CollapsibleMessageBody";
import { getDisplayModelName } from "../chat/providerIconUtils";
import {
  isTimelineMinimapRowVisible,
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapVisibleRange,
  TIMELINE_MINIMAP_MIN_ITEMS,
} from "../chat/MessagesTimeline.logic";
import { TaskEventActivityRow } from "../chat/TaskEventActivityRow";
import { ScrollToEndButton } from "../chat/TimelineOverlays";
import { TimelineMinimap } from "../chat/TimelineMinimap";
import type { TimelineMinimapItem } from "../chat/timelineMinimapItems";
import { forwardWheelToTimeline } from "../chat/timelineMinimapWheel";
import { MESSAGE_HEADING_LEVEL } from "../chat/TimelineRowParts";
import { WorkedForFold } from "../chat/WorkedForFold";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openAssistantDialog } from "./assistantDialogState";
import { AssistantAvatar, AssistantCluster, removedAssistantFace } from "./assistantPresentation";
import { toggleAssistantInfo } from "./assistantInfoState";
import {
  openAssistantGroupRoutines,
  openAssistantGroupSettings,
  openAssistantTeamDialog,
} from "./assistantTeamState";
import { GroupMessageAttachments } from "./GroupAttachments";
import {
  GroupComposer,
  type GroupLandedSend,
  type GroupProjectOption,
  type GroupReplyTarget as ReplyTarget,
  type GroupSendResult,
  type GroupSendRouting,
} from "./GroupComposer";
import { GroupMentionChip, GroupProjectChip, type GroupMentionProject } from "./GroupMentionChip";
import { RelativeTime } from "../RelativeTime";
import { useAssistantStatus } from "../sidebar/useSidebarZones";
import { useUsageLimitLabel } from "./useUsageLimitLabel";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  MemberProjectModelDialog,
  ProjectModelDialog,
  useMemberModelExceptions,
} from "./GroupProjectModel";
import { GroupTaskCard } from "./GroupTaskCard";
import { useGroupReadMarker } from "./useGroupReadMarker";
import { useAssistantTeamFlows } from "./useAssistantFlows";

function failed(title: string, message: string) {
  toastManager.add({ type: "error", title, description: message });
}

function GroupTaskLine(props: {
  readonly task: AssistantGroupTask;
  readonly environmentId: EnvironmentId;
  readonly onOpen: () => void;
}) {
  const shell = useQuietThreadShell(scopeThreadRef(props.environmentId, props.task.threadId));
  return (
    <TaskEventActivityRow
      {...assistantGroupActivity(props.task.status, {
        threadTitle: shell?.title,
        instruction: props.task.instruction,
      })}
      onOpen={props.onOpen}
    />
  );
}

function GroupHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam;
  readonly members: ReadonlyArray<Assistant>;
  readonly allAssistants: ReadonlyArray<Assistant>;
  readonly running: number;
  /** The project new messages run in, for each member's own model there. */
  readonly modelProject: GroupProjectOption | null;
  readonly onProjectModel: () => void;
  readonly onMemberModel: (member: Assistant) => void;
}) {
  const { environmentId, team, modelProject } = props;
  const flows = useAssistantTeamFlows(environmentId);
  const navigate = useNavigate();
  const exceptions = useMemberModelExceptions(environmentId, modelProject?.id ?? null);
  const providers = useEnvironmentProviders().get(environmentId);
  const modelName = (selection: ModelSelection) => {
    const found = providers
      ?.find((provider) => provider.instanceId === selection.instanceId)
      ?.models.find((model) => model.slug === selection.model);
    return found ? getDisplayModelName(found) : formatModelSlugName(selection.model);
  };
  const archived = team.archivedAt !== null;
  const status = useAssistantStatus();
  const limitLabel = useUsageLimitLabel();
  const homeProjectId = props.members[0]?.projectId;
  const homeProject = useProjects().find(
    (project) => project.environmentId === environmentId && project.id === homeProjectId,
  );
  return (
    <WorkspacePageHeader electron={isElectron} className="relative bg-background" data-glass-layer>
      <div className="@container/header flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <WorkspaceBreadcrumb
          ariaLabel="Group chat"
          className="flex-1 overflow-clip [overflow-clip-margin:2px]"
        >
          <WorkspaceBreadcrumbItem>
            <button
              type="button"
              onClick={() => void navigate({ to: "/assistants" })}
              className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {homeProject ? <ProjectFavicon project={homeProject} className="size-3.5" /> : null}
              <WorkspaceBreadcrumbText>Assistants</WorkspaceBreadcrumbText>
            </button>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator>
            <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbSeparator>
          <WorkspaceBreadcrumbItem current className="min-w-10 flex-1 gap-1.5">
            <HashIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="min-w-0 truncate">
              <WorkspaceBreadcrumbText>{team.name}</WorkspaceBreadcrumbText>
            </h1>
            <WorkspaceBreadcrumbText className="text-xs font-normal text-muted-foreground @max-xl/header:hidden">
              · {teamSummary(team, props.allAssistants)}
            </WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-testid="group-avatars"
                aria-label={`${team.name}, Group info`}
                onClick={() =>
                  toggleAssistantInfo({ kind: "group", environmentId, teamId: team.id })
                }
                className="flex shrink-0 cursor-pointer items-center rounded-sm transition-opacity hover:opacity-80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @max-md/header:hidden"
              />
            }
          >
            <AssistantCluster
              environmentId={environmentId}
              className="size-6"
              faces={team.memberIds.map((id) => {
                const member = props.members.find((candidate) => candidate.id === id);
                return {
                  key: id,
                  assistant: member ?? removedAssistantFace(id),
                  ...(member === undefined
                    ? {}
                    : { mood: status.of(environmentId, member, limitLabel).mood }),
                };
              })}
            />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Group info</TooltipPopup>
        </Tooltip>
        {props.running > 0 ? (
          <Badge variant="info" size="sm" className="shrink-0" data-testid="group-running">
            {props.running} running
          </Badge>
        ) : null}
      </div>
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
          {modelProject === null || props.members.length === 0 ? null : (
            <MenuSub>
              <MenuSubTrigger>
                <BoxIcon />
                <span className="max-w-56 truncate">Model in {modelProject.label}</span>
              </MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem onClick={props.onProjectModel}>
                  <FolderCogIcon />
                  <span className="min-w-0 flex-1 truncate">Project's model</span>
                </MenuItem>
                <MenuSeparator />
                {props.members.map((member) => {
                  const exception = exceptions[member.id];
                  return (
                    <MenuItem key={member.id} onClick={() => props.onMemberModel(member)}>
                      <AssistantAvatar
                        assistant={member}
                        environmentId={environmentId}
                        className="size-4"
                      />
                      <span className="min-w-0 flex-1 truncate">{member.name}</span>
                      <span className="ms-3 shrink-0 text-xs text-muted-foreground">
                        {exception ? modelName(exception) : "No exception"}
                      </span>
                    </MenuItem>
                  );
                })}
              </MenuSubPopup>
            </MenuSub>
          )}
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
  /** Where the message's request runs, so a notification reads back to its project. */
  readonly project: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
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
      {props.project}
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

/** The members with a task in a request, by their newest task's face; each opens its thread. */
function RequestOwners(props: {
  readonly environmentId: EnvironmentId;
  readonly owners: ReadonlyArray<AssistantGroupTask>;
  readonly assistants: ReadonlyMap<string, Assistant>;
  readonly onOpenThread: (threadId: AssistantGroupTask["threadId"]) => void;
}) {
  if (props.owners.length === 0) return null;
  return (
    <span data-testid="group-request-owners" className="flex shrink-0 items-center gap-0.5">
      {props.owners.map((task) => {
        const member = props.assistants.get(task.ownerId);
        const label = `${member?.name ?? "Removed member"} · ${ASSISTANT_GROUP_STATUS_LABEL[task.status]}`;
        return (
          <Tooltip key={task.ownerId}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`${label}. Open thread`}
                  onClick={() => props.onOpenThread(task.threadId)}
                  className="flex size-6 cursor-pointer items-center justify-center rounded-full outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              <AssistantAvatar
                assistant={member ?? removedAssistantFace(task.ownerId)}
                environmentId={props.environmentId}
                mood={ASSISTANT_GROUP_TASK_MOOD[task.status]}
                className="size-5"
              />
            </TooltipTrigger>
            <TooltipPopup side="top">{label} · Open thread</TooltipPopup>
          </Tooltip>
        );
      })}
    </span>
  );
}

/** A request's tasks as a tree: who handed what to whom, each with its state, time and thread. */
function RequestTaskTree(props: {
  readonly environmentId: EnvironmentId;
  readonly tasks: ReadonlyArray<AssistantGroupTask>;
  readonly assistants: ReadonlyMap<string, Assistant>;
  readonly onOpenThread: (threadId: AssistantGroupTask["threadId"]) => void;
}) {
  // One task is already its own card; a tree starts with a hand-off.
  if (props.tasks.length < 2) return null;
  return (
    <ul data-testid="group-task-tree" aria-label="Tasks" className="flex flex-col gap-0.5 text-xs">
      {assistantGroupTaskTree(props.tasks).map(({ task, depth }) => {
        const member = props.assistants.get(task.ownerId);
        const open = ASSISTANT_GROUP_WORKING_TASK_STATUSES.some((status) => status === task.status);
        return (
          <li key={task.id} style={{ paddingInlineStart: `${depth * 1.25}rem` }}>
            <button
              type="button"
              data-testid="group-task-tree-row"
              onClick={() => props.onOpenThread(task.threadId)}
              className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <AssistantAvatar
                assistant={member ?? removedAssistantFace(task.ownerId)}
                environmentId={props.environmentId}
                mood={ASSISTANT_GROUP_TASK_MOOD[task.status]}
                className="size-4"
              />
              <span className="shrink-0 font-medium">{member?.name ?? "Removed member"}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {task.instruction}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {ASSISTANT_GROUP_STATUS_LABEL[task.status]}
              </span>
              <span className="shrink-0 text-muted-foreground/70 tabular-nums">
                {open ? (
                  <RelativeTime timestamp={task.createdAt} />
                ) : (
                  formatDuration(Date.parse(task.updatedAt) - Date.parse(task.createdAt))
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Who works on what: one line per member with open work, each opening that member's thread. */
/** The requests that wait on the user in this tab, each one click from its place in the feed. */
function WaitingStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<AssistantGroupWaitingItem>;
  readonly assistants: ReadonlyMap<string, Assistant>;
  readonly lead: Assistant | undefined;
  readonly canResume: boolean;
  readonly onOpen: (requestId: AssistantGroupWaitingItem["requestId"]) => void;
  readonly onResume: (task: AssistantGroupTask) => void;
}) {
  if (props.items.length === 0) return null;
  return (
    <section
      aria-label={`Waiting on you (${props.items.length})`}
      data-testid="group-waiting"
      data-glass-layer
      className="chat-composer-lane border-b border-foreground/8 py-1.5"
    >
      <div className="chat-content-lane flex flex-col gap-0.5">
        <h2 className="px-1.5 text-xs font-medium text-warning-foreground">
          Waiting on you ({props.items.length})
        </h2>
        <ul className="flex max-h-28 flex-col overflow-y-auto">
          {props.items.map((item) => {
            const member =
              item.assistantId === null ? props.lead : props.assistants.get(item.assistantId);
            const why = assistantGroupWaitingWhy({
              reason: item.reason,
              taskReason: item.task?.reason ?? null,
            });
            return (
              <li key={item.requestId} className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  data-testid="group-waiting-row"
                  aria-label={`${item.title}. ${why}. Open request`}
                  onClick={() => props.onOpen(item.requestId)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {member === undefined ? null : (
                    <AssistantAvatar
                      assistant={member}
                      environmentId={props.environmentId}
                      className="size-4"
                    />
                  )}
                  <span className="shrink-0 font-medium text-foreground">
                    {member?.name ?? "Former member"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground/80">{item.title}</span>
                  <span className="shrink-0 text-muted-foreground @max-sm/group-chat:hidden">
                    {why}
                  </span>
                </button>
                {item.task === null || !props.canResume ? null : (
                  <Button
                    size="xs"
                    variant="ghost"
                    data-testid="group-waiting-resume"
                    onClick={() => props.onResume(item.task!)}
                  >
                    <PlayIcon />
                    Resume
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function MemberWorkStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly work: ReadonlyArray<AssistantGroupMemberWork>;
  readonly assistants: ReadonlyMap<string, Assistant>;
  readonly projectChip: (projectId: ProjectId | null) => ReactNode;
  readonly onOpenThread: (threadId: AssistantGroupTask["threadId"]) => void;
}) {
  if (props.work.length === 0) return null;
  return (
    <div
      data-testid="group-member-work"
      data-glass-layer
      className="chat-composer-lane border-b border-foreground/8 py-1.5"
    >
      <ul aria-label="Members at work" className="chat-content-lane flex flex-wrap gap-x-2 gap-y-1">
        {props.work.map(({ task, projectId }) => {
          const member = props.assistants.get(task.ownerId);
          return (
            <li key={task.id} className="min-w-0">
              <button
                type="button"
                data-testid="group-member-work-row"
                onClick={() => props.onOpenThread(task.threadId)}
                className="flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {member === undefined ? null : (
                  <AssistantAvatar
                    assistant={member}
                    environmentId={props.environmentId}
                    className="size-4"
                  />
                )}
                <span className="truncate font-medium text-foreground">
                  {member?.name ?? "Former member"}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {ASSISTANT_GROUP_STATUS_LABEL[task.status]}
                </span>
                {props.projectChip(projectId)}
                <span className="shrink-0 text-muted-foreground/70 tabular-nums">
                  <RelativeTime timestamp={task.updatedAt} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
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
  /** The request project's root, for file links. */
  readonly cwd: string | undefined;
  /** The request's project chip; null outside a request or without a project. */
  readonly projectChip: ReactNode;
  readonly timestampFormat: TimestampFormat;
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
  const [workedOpen, setWorkedOpen] = useState(false);
  const author =
    message.assistantId === null ? undefined : props.assistants.get(message.assistantId);
  const answered = message.taskId === null ? undefined : props.chat.tasks.get(message.taskId);
  const answeredShell = useQuietThreadShell(
    answered === undefined ? null : scopeThreadRef(props.environmentId, answered.threadId),
  );
  const answeredProject = useProject(
    answeredShell === null ? null : scopeProjectRef(props.environmentId, answeredShell.projectId),
  );
  const markdown = (text: string, lineBreaks = shouldPreserveAssistantLineBreaks(text)) => (
    <ChatMarkdown
      text={assistantGroupMarkdownMentions(text, props.members, props.projects)}
      cwd={
        assistantGroupAnswerRoot({
          thread:
            answeredShell === null
              ? null
              : {
                  worktreePath: answeredShell.worktreePath,
                  projectRoot: answeredProject?.workspaceRoot,
                },
          requestRoot: props.cwd,
        }) ?? undefined
      }
      threadRef={
        answered === undefined ? undefined : scopeThreadRef(props.environmentId, answered.threadId)
      }
      environmentId={props.environmentId}
      headingLevelOffset={MESSAGE_HEADING_LEVEL}
      lineBreaks={lineBreaks}
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
  // A finished task is one activity line, as in a thread; an open one keeps its card and actions.
  const cards = props.row.tasks.map((task) =>
    task.status === "completed" || task.status === "cancelled" ? (
      <GroupTaskLine
        key={task.id}
        task={task}
        environmentId={props.environmentId}
        onOpen={() => props.onOpenConversation(task)}
      />
    ) : (
      <GroupTaskCard
        key={task.id}
        task={task}
        environmentId={props.environmentId}
        owner={props.row.role === "answer" ? undefined : props.assistants.get(task.ownerId)}
        project={props.projectChip}
        reassignTo={props.members.filter((member) => member.id !== task.ownerId)}
        canAct={props.canAct}
        onAction={(action, ownerId) => props.onTaskAction(task, action, ownerId)}
        onOpenConversation={() => props.onOpenConversation(task)}
      />
    ),
  );
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
        {cards.length > 0 ? <div className="w-full">{cards}</div> : null}
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
          <span className="flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground">
            {author === undefined ? null : (
              <AssistantAvatar
                assistant={author}
                environmentId={props.environmentId}
                className="size-4"
              />
            )}
            {label}
            {props.projectChip}
          </span>
        )}
        {replyLine}
        <div
          className={cn(
            "min-w-0 max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm wrap-anywhere text-message-foreground @xl/group-chat:max-w-[75%]",
            fromUser ? "bg-message" : "bg-foreground/6",
            BUBBLE_CHIP_INK,
          )}
        >
          {/* A request keeps its line breaks, as the thread shows a user message. */}
          {parts.body === "" ? null : markdown(parts.body, true)}
          {parts.files === null ? null : (
            <div data-testid="group-request-files" className="mt-1.5">
              <ChatMarkdown
                text={parts.files}
                cwd={props.cwd}
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
        {cards.length > 0 ? <div className="w-full self-stretch">{cards}</div> : null}
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
        <Who
          member={author}
          fallback={name}
          createdAt={message.createdAt}
          project={props.projectChip}
        />
        {replyLine === null ? null : <div className="-ms-1.5">{replyLine}</div>}
        {answered === undefined ? null : (
          <WorkedForFold
            label={assistantGroupWorkedLabel(message)}
            expanded={workedOpen}
            loading={false}
            error={null}
            onToggle={() => setWorkedOpen((open) => !open)}
            createdAt={message.createdAt}
            timestampFormat={props.timestampFormat}
          >
            {workedOpen ? (
              <p
                data-testid="group-worked-instruction"
                className="px-1 pt-1 text-sm whitespace-pre-wrap wrap-anywhere text-muted-foreground"
              >
                {assistantGroupInstructionBody(answered.instruction)}
              </p>
            ) : null}
          </WorkedForFold>
        )}
        <CollapsibleMessageBody text={message.text}>
          {markdown(message.text)}
        </CollapsibleMessageBody>
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
  stopped: "text-muted-foreground",
  done: "text-success-foreground",
  cancelled: "text-muted-foreground",
};

/** A request's messages and its project and reply actions, below whichever header it has. */
function RequestBody(props: {
  readonly block: AssistantGroupRequestBlock;
  readonly projects: ReadonlyArray<GroupProjectOption>;
  readonly canPick: boolean;
  readonly onPickProject: (project: GroupProjectOption) => void;
  readonly onReply: () => void;
  readonly tree: ReactNode;
  readonly children: ReactNode;
}) {
  const { block } = props;
  return (
    <div className="flex min-w-0 flex-col gap-3 border-t border-foreground/10 px-3 py-3">
      {props.tree}
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
  );
}

/** A project label truncated before its number, so "Removed project 2" never reads as the first. */
function ProjectLabelText(props: { readonly label: string; readonly testId?: string }) {
  const match = /^(.*?)( \d+)?$/.exec(props.label);
  const head = match?.[1] ?? props.label;
  const tail = match?.[2];
  return (
    <span className="flex min-w-0" data-testid={props.testId}>
      <span className="truncate">{head}</span>
      {tail === undefined ? null : <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  );
}

/** A request with its messages and cards, folded to its header when the user closes it. */
/** A request the user was sent to: ringed for two seconds, then plain again. */
const REQUEST_HIGHLIGHT =
  "scroll-my-4 rounded-xl outline-none data-highlighted:ring-2 data-highlighted:ring-warning/60";
const HIGHLIGHT_MS = 2000;

function RequestBlock(props: {
  readonly block: AssistantGroupRequestBlock;
  readonly projectName: string | null;
  /** In All: the request is one activity line tagged with its project, open or closed. */
  readonly allChip: string | null | undefined;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly projects: ReadonlyArray<GroupProjectOption>;
  readonly canPick: boolean;
  readonly onPickProject: (project: GroupProjectOption) => void;
  readonly onReply: () => void;
  /** The owners' faces, each opening its thread; drawn beside the open header. */
  readonly owners: ReactNode;
  /** The same faces as a still mark, inside a folded line that is itself a button. */
  readonly ownerFaces: ReactNode;
  readonly tree: ReactNode;
  readonly children: ReactNode;
}) {
  const { block } = props;
  if (props.allChip !== undefined) {
    const activity = assistantGroupActivity(block.status);
    return (
      <section
        data-testid="group-request-block"
        data-request-id={block.requestId}
        aria-label={block.title}
        tabIndex={-1}
        className={cn(
          "flex min-w-0 flex-col",
          REQUEST_HIGHLIGHT,
          props.expanded && "rounded-xl border border-foreground/10",
        )}
      >
        <TaskEventActivityRow
          title={block.title}
          status={activity.status}
          label={activity.label}
          chip={
            props.allChip === null ? (
              props.ownerFaces
            ) : (
              <>
                {props.ownerFaces}
                <span
                  data-testid="group-request-chip"
                  className="flex max-w-28 min-w-0 shrink-0 items-center gap-1 rounded-md bg-foreground/8 px-1.5 py-0.5 text-foreground/80"
                >
                  <FolderIcon aria-hidden className="size-3 shrink-0" />
                  <ProjectLabelText label={props.allChip} />
                </span>
              </>
            )
          }
          onOpen={props.onToggle}
          action={props.expanded ? "Collapse request" : "Expand request"}
          actionLabel={props.expanded ? "Collapse" : "Expand"}
        />
        {props.expanded ? <RequestBody {...props} /> : null}
      </section>
    );
  }
  if (!props.expanded) {
    const activity = assistantGroupActivity(block.status);
    return (
      <section
        data-testid="group-request-block"
        data-request-id={block.requestId}
        aria-label={block.title}
        tabIndex={-1}
        className={cn("min-w-0", REQUEST_HIGHLIGHT)}
      >
        <TaskEventActivityRow
          title={block.title}
          status={activity.status}
          label={activity.label}
          project={props.projectName}
          chip={props.ownerFaces}
          onOpen={props.onToggle}
          action="Open request"
        />
      </section>
    );
  }
  return (
    <section
      data-testid="group-request-block"
      data-request-id={block.requestId}
      aria-label={block.title}
      tabIndex={-1}
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-foreground/10",
        REQUEST_HIGHLIGHT,
      )}
    >
      <div className="flex min-w-0 items-center gap-1 pe-2">
        <button
          type="button"
          aria-expanded={props.expanded}
          data-testid="group-request-header"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-left outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={props.onToggle}
        >
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 rotate-90 text-muted-foreground"
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
              <ProjectLabelText label={props.projectName} testId="group-request-project" />
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
        {props.owners}
      </div>
      <RequestBody {...props} />
    </section>
  );
}

/** Brings the pressed tab into view once the row mounts, as a remembered tab may sit off screen. */
function revealPressedTab(element: HTMLDivElement | null) {
  element?.querySelector("[data-pressed]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** All, one tab per project and General, each with its unread count and a dot while it waits. */
function GroupTabs(props: {
  readonly tabs: ReadonlyArray<AssistantGroupTab>;
  readonly active: AssistantGroupTabKey;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** What a waiting tab's tooltip says, as the group's sidebar indicator does. */
  readonly detail: (tab: AssistantGroupTab) => ReadonlyArray<string>;
  readonly onSelect: (key: AssistantGroupTabKey) => void;
}) {
  return (
    <div
      data-glass-layer
      ref={revealPressedTab}
      className="flex shrink-0 border-b border-foreground/12 px-3 py-1 @xl/group-chat:px-6"
    >
      <ScrollArea hideScrollbars>
        <ToggleGroup
          aria-label="Project tabs"
          variant="segmented"
          value={[props.active]}
          onValueChange={(value) => {
            const next = props.tabs.find((tab) => tab.key === value[0]);
            // Pressing the active tab again empties the value; it stays selected.
            if (next !== undefined) props.onSelect(next.key);
          }}
        >
          {props.tabs.map((tab) => {
            const project = props.projects.find((entry) => entry.id === tab.projectId);
            const toggle = (
              <Toggle key={tab.key} value={tab.key}>
                {project === undefined ? null : (
                  <ProjectFavicon project={project} className="size-3.5" />
                )}
                <span className="max-w-40 truncate">{tab.label}</span>
                {tab.unreadCount > 0 ? (
                  <span className="text-muted-foreground tabular-nums">{tab.unreadCount}</span>
                ) : null}
                {tab.waiting ? (
                  <span
                    role="img"
                    aria-label="Waiting on you"
                    className="size-1.5 shrink-0 rounded-full bg-warning"
                  />
                ) : null}
              </Toggle>
            );
            if (!tab.waiting) return toggle;
            return (
              <Tooltip key={tab.key}>
                <TooltipTrigger render={toggle} />
                <TooltipPopup side="bottom">
                  <div className="flex flex-col gap-0.5" data-testid="group-tab-detail">
                    {props.detail(tab).map((line) => (
                      <span key={line}>{line}</span>
                    ))}
                  </div>
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </ToggleGroup>
      </ScrollArea>
    </div>
  );
}

/** What the composer reaches in the feed, which is remounted for each tab. */
interface GroupFeedHandle {
  readonly jumpTo: (messageId: AssistantGroupMessage["id"]) => void;
  /** Scrolls to a request, loading older pages until it shows or the history ends. */
  readonly goToRequest: (requestId: string) => void;
  readonly followEnd: () => void;
}

/** One tab's feed: its pages, open requests, New line, scroll position and minimap. */
function GroupFeed(props: {
  readonly handle: Ref<GroupFeedHandle>;
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam;
  /** Null when the chat has no tabs: the whole chat, read and marked as a whole. */
  readonly tab: AssistantGroupTab | null;
  readonly live: AssistantGroupChatState | null;
  readonly members: ReadonlyArray<Assistant>;
  readonly byId: ReadonlyMap<string, Assistant>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly groupProjects: ReadonlyArray<GroupProjectOption>;
  readonly archived: boolean;
  readonly onReply: (target: ReplyTarget) => void;
}) {
  const { environmentId, team, tab, members, byId, projects, groupProjects, archived } = props;
  const teamId = team.id;
  const scope = tab?.scope;
  const all = tab?.key === "all";
  const actions = useAssistantGroupActions(environmentId);
  const navigate = useNavigate();
  const [pages, setPages] = useState<ReadonlyArray<AssistantGroupsHistoryResult>>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The user's own open or closed choice per request; the rest follow assistantGroupRequestExpanded.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const anchor = useRef<{ readonly height: number; readonly top: number } | null>(null);
  const pinnedSize = useRef("");
  const [atBottom, setAtBottom] = useState(true);
  // Where the "New" line goes, fixed when the chat first shows: it stays until the user leaves.
  const [newSeq, setNewSeq] = useState<number | null | undefined>(undefined);
  const scrolledToNew = useRef(false);
  // A message to bring into view and flash once the render that shows it lands.
  const jumpTarget = useRef<string | null>(null);
  // A request to bring into view and highlight once the render that shows it lands.
  const seeking = useRef<string | null>(null);
  const [, setJumps] = useState(0);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [minimapStrips] = useState(() => new Map<string, HTMLSpanElement>());
  const [minimap, setMinimap] = useState({
    persistentGutter: false,
    hitStripWidth: 0,
    currentIndex: null as number | null,
    atEnd: true,
  });

  const chat =
    props.live === null
      ? null
      : pages.reduce((state, page) => applyAssistantGroupHistory(state, page), props.live);
  const feed = chat === null ? [] : assistantGroupRequestFeed(chat);
  const projectName = (id: ProjectId) =>
    assistantGroupProjectLabel(
      id,
      projects,
      team.chat?.scopes,
      groupProjects.map((project) => project.id),
      team.chat?.removedProjectIds,
    );
  // A request that left this tab's project since it was sent no longer belongs here.
  const items = feed.filter(
    (item) => item.kind !== "request" || assistantGroupInScope(item.block, scope),
  );
  const newestRequest = items.findLast((item) => item.kind === "request");
  const requestBlocks = items.flatMap((item) => (item.kind === "request" ? [item.block] : []));
  const minimapItems: ReadonlyArray<TimelineMinimapItem> = requestBlocks.map((block, index) => ({
    id: block.requestId,
    rowIndex: index,
    userText: block.title,
    assistantText: block.rows.findLast((row) => row.role === "answer")?.message.text ?? null,
    assistantId: null,
  }));
  const mentionProjects: ReadonlyArray<GroupMentionProject> = groupProjects.map((project) => ({
    id: project.id,
    name: project.label,
  }));
  const readSeq = tab?.readSeq ?? team.chat?.readSeq ?? 0;
  // Read position when the chat opened: blocks with unread messages stay open while they are read.
  const [readAtOpen, setReadAtOpen] = useState<number | null>(null);
  if (newSeq === undefined && chat !== null) {
    // A server without counters sends none: there is no position to draw a line from.
    setNewSeq(
      team.chat === undefined
        ? null
        : assistantGroupNewSeq(chat, all ? assistantGroupAllReadSeq(chat, team.chat) : readSeq),
    );
    setReadAtOpen(team.chat === undefined ? null : readSeq);
  }
  useGroupReadMarker({
    latestSeq: chat === null ? null : assistantGroupLatestSeq(chat),
    readSeq,
    atBottom,
    // All shows every tab at once, so reaching its end reads none of them.
    enabled: team.chat !== undefined && actions.canMarkRead && !all,
    markRead: (next) => void actions.markRead(teamId, { readSeq: next }, scope),
  });

  /**
   * Marks the requests on screen and where the reader is, as the thread's minimap does. Runs on
   * scroll and resize only: it measures every block.
   */
  const refreshMinimap = useStableCallback((element: HTMLDivElement) => {
    if (minimapItems.length < TIMELINE_MINIMAP_MIN_ITEMS) return;
    const top = element.getBoundingClientRect().top - element.scrollTop;
    // The blocks render in the same order as the minimap's items.
    const boxes = [...element.querySelectorAll("[data-request-id]")].map((block) =>
      block.getBoundingClientRect(),
    );
    const range = resolveTimelineMinimapVisibleRange({
      startBuffered: 0,
      endBuffered: boxes.length - 1,
      scroll: element.scrollTop,
      scrollLength: element.clientHeight,
      positionAtIndex: (index) => (boxes[index] === undefined ? undefined : boxes[index].top - top),
      sizeAtIndex: (index) => boxes[index]?.height,
    });
    for (const item of minimapItems) {
      const next = isTimelineMinimapRowVisible(item.rowIndex, range.start, range.end)
        ? "true"
        : "false";
      const strip = minimapStrips.get(item.id);
      if (strip && strip.dataset.inView !== next) strip.dataset.inView = next;
    }
    const currentIndex = resolveTimelineMinimapCurrentIndex({
      visibleStart: range.start,
      visibleEnd: range.end,
      rowIndices: minimapItems.map((item) => item.rowIndex),
    });
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
    setMinimap((current) =>
      current.currentIndex === currentIndex && current.atEnd === atEnd
        ? current
        : { ...current, currentIndex, atEnd },
    );
  });

  // Stable, so React attaches it once instead of re-observing on every render.
  const bindScroller = useStableCallback((element: HTMLDivElement | null) => {
    scroller.current = element;
    if (element === null) return;
    // The lane changes width with the chat-width setting too, not only with the window.
    const lane = element.querySelector("[data-timeline-root]");
    return observeResize(lane === null ? element : [element, lane], () => {
      const viewportWidth = element.getBoundingClientRect().width;
      const contentWidth = lane?.getBoundingClientRect().width ?? viewportWidth;
      const persistentGutter = resolveTimelineMinimapHasPersistentGutter(
        viewportWidth,
        contentWidth,
      );
      const hitStripWidth = resolveTimelineMinimapHitStripWidth(viewportWidth, contentWidth);
      setMinimap((current) =>
        current.persistentGutter === persistentGutter && current.hitStripWidth === hitStripWidth
          ? current
          : { ...current, persistentGutter, hitStripWidth },
      );
      // Content growing or folding resizes the lane, which moves the blocks.
      refreshMinimap(element);
    });
  });

  const loadOlder = async () => {
    if (chat === null || !chat.hasMore || loadingOlder) return;
    const element = scroller.current;
    setLoadingOlder(true);
    const reply = await actions.olderThan(teamId, chat, scope);
    setLoadingOlder(false);
    if (!reply.ok) return failed("Could not load earlier messages", reply.message);
    if (element !== null) anchor.current = { height: element.scrollHeight, top: element.scrollTop };
    setPages((current) => [...current, reply.value]);
  };

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
      // Only a size change re-pins: a render during a smooth jump must not snap it back.
      const size = `${element.scrollHeight}:${element.clientHeight}`;
      if (size !== pinnedSize.current) element.scrollTop = element.scrollHeight;
      pinnedSize.current = size;
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
    if (seeking.current !== null) {
      const target = element.querySelector(`[data-request-id="${CSS.escape(seeking.current)}"]`);
      seeking.current = null;
      if (target instanceof HTMLElement) {
        scrolledToNew.current = true;
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
        target.focus({ preventScroll: true });
        target.dataset.highlighted = "";
        window.setTimeout(() => delete target.dataset.highlighted, HIGHLIGHT_MS);
      } else {
        failed("Request not found", "It is no longer in this chat.");
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

  const running = chat === null ? 0 : assistantGroupRunningCount(chat);
  const blockTasks = (block: AssistantGroupRequestBlock) => block.rows.flatMap((row) => row.tasks);
  const scrollToEnd = () => {
    const element = scroller.current;
    if (element === null) return;
    stickToBottom.current = true;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({ top: element.scrollHeight, behavior: still ? "auto" : "smooth" });
  };

  /** Brings a message into view, opening its request. */
  const jumpTo = (messageId: AssistantGroupMessage["id"]) => {
    const holder = requestBlocks.find(
      (block) =>
        block.requestId === messageId || block.rows.some((row) => row.message.id === messageId),
    );
    if (holder !== undefined) {
      setToggled((current) => new Map(current).set(holder.requestId, true));
    }
    stickToBottom.current = false;
    jumpTarget.current = messageId;
    setJumps((count) => count + 1);
  };
  const goToRequest = async (requestId: string) => {
    if (chat === null) return;
    const holds = (state: AssistantGroupChatState) =>
      [...state.messages.values()].some((message) => message.requestId === requestId);
    // ponytail: pages one by one; a jump far back would want a server read around the request.
    let state = chat;
    const loaded: AssistantGroupsHistoryResult[] = [];
    while (!holds(state) && state.hasMore) {
      const reply = await actions.olderThan(teamId, state, scope);
      if (!reply.ok) return failed("Could not load earlier messages", reply.message);
      loaded.push(reply.value);
      state = applyAssistantGroupHistory(state, reply.value);
    }
    if (!holds(state)) return failed("Request not found", "It is no longer in this chat.");
    if (loaded.length > 0) setPages((current) => [...current, ...loaded]);
    setToggled((current) => new Map(current).set(requestId, true));
    stickToBottom.current = false;
    seeking.current = requestId;
    setJumps((count) => count + 1);
  };
  useImperativeHandle(props.handle, () => ({
    jumpTo,
    goToRequest: (requestId) => void goToRequest(requestId),
    followEnd: () => {
      stickToBottom.current = true;
    },
  }));

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

  const lead = members.find((member) => member.id === team.leadId);
  const requestRoot = (state: AssistantGroupChatState, message: AssistantGroupMessage) => {
    const projectId = assistantGroupRequestProject(state, message.requestId);
    return projects.find((project) => project.id === projectId)?.workspaceRoot;
  };
  const projectChip = (projectId: ProjectId | null) =>
    projectId === null ? null : (
      <GroupProjectChip
        environmentId={environmentId}
        projectId={projectId}
        label={projectName(projectId)}
      />
    );
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
        cwd={requestRoot(state, row.message)}
        projectChip={projectChip(assistantGroupRequestProject(state, row.message.requestId))}
        timestampFormat={timestampFormat}
        lead={lead}
        canAct={actions.canAct}
        archived={archived}
        onJump={jumpTo}
        onReply={(message, name) => {
          const projectId = assistantGroupRequestProject(state, message.requestId);
          props.onReply({
            id: message.id,
            projectId,
            quote: {
              label: `Replying to ${name}`,
              excerpt: assistantGroupMessageExcerpt(message.text),
              to: name,
              projectId,
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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <WaitingStrip
        environmentId={environmentId}
        items={
          chat === null
            ? []
            : assistantGroupWaitingRequests(chat).filter((item) =>
                assistantGroupInScope(item, scope),
              )
        }
        assistants={byId}
        lead={lead}
        canResume={actions.canAct && !archived}
        onOpen={(requestId) => void goToRequest(requestId)}
        onResume={(task) => void taskAction(task, "resume")}
      />
      <MemberWorkStrip
        environmentId={environmentId}
        work={chat === null ? [] : assistantGroupMemberWork(chat)}
        assistants={byId}
        projectChip={projectChip}
        onOpenThread={openThread}
      />
      <div
        ref={bindScroller}
        data-testid="group-feed"
        className="chat-composer-lane min-h-0 flex-1 overflow-y-auto overscroll-y-none"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          setAtBottom(stickToBottom.current);
          refreshMinimap(element);
          if (element.scrollTop < 48) void loadOlder();
        }}
      >
        <div className="messages-timeline-row-frame flex min-h-full flex-col justify-end py-4">
          <div className="chat-content-lane flex flex-col gap-3 overflow-x-clip" data-timeline-root>
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
            {chat !== null && items.length === 0 ? (
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
                  const owners = assistantGroupRequestOwners(blockTasks(block));
                  const expanded =
                    toggled.get(block.requestId) ??
                    (!all &&
                      assistantGroupRequestExpanded(
                        block,
                        readAtOpen ?? Number.MAX_SAFE_INTEGER,
                        item === newestRequest,
                      ));
                  return (
                    <RequestBlock
                      key={block.requestId}
                      block={block}
                      projectName={block.projectId === null ? null : projectName(block.projectId)}
                      allChip={
                        !all
                          ? undefined
                          : block.projectId === null
                            ? null
                            : projectName(block.projectId)
                      }
                      expanded={expanded}
                      onToggle={() =>
                        setToggled((current) => new Map(current).set(block.requestId, !expanded))
                      }
                      projects={groupProjects}
                      canPick={!archived && actions.canPost}
                      onPickProject={(project) => void pickProject(block, project)}
                      owners={
                        <RequestOwners
                          environmentId={environmentId}
                          owners={owners}
                          assistants={byId}
                          onOpenThread={openThread}
                        />
                      }
                      ownerFaces={
                        owners.length === 0 ? null : (
                          <AssistantCluster
                            environmentId={environmentId}
                            className="size-4"
                            faces={owners.map((task) => ({
                              key: task.ownerId,
                              assistant:
                                byId.get(task.ownerId) ?? removedAssistantFace(task.ownerId),
                              mood: ASSISTANT_GROUP_TASK_MOOD[task.status],
                            }))}
                          />
                        )
                      }
                      tree={
                        <RequestTaskTree
                          environmentId={environmentId}
                          tasks={blockTasks(block)}
                          assistants={byId}
                          onOpenThread={openThread}
                        />
                      }
                      onReply={() =>
                        props.onReply({
                          id: block.requestId,
                          projectId: block.projectId,
                          quote: {
                            label: `Replying to request: ${block.title}`,
                            excerpt: "",
                            to: null,
                            projectId: block.projectId,
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
      </div>
      {atBottom ? null : (
        <ScrollToEndButton
          bottom={4}
          summary={running === 0 ? null : `${running} running`}
          onScrollToEnd={scrollToEnd}
        />
      )}
      <TimelineMinimap
        items={minimapItems}
        hasPersistentGutter={minimap.persistentGutter}
        hitStripWidth={minimap.hitStripWidth}
        currentIndex={minimap.currentIndex}
        atEnd={minimap.atEnd}
        stripMap={minimapStrips}
        onWheel={(event) => {
          if (scroller.current !== null) forwardWheelToTimeline(event, scroller.current);
        }}
        onSelect={(item) => {
          const block = requestBlocks.find((entry) => entry.requestId === item.id);
          // The request's first message may be unloaded; its first loaded row is always drawn.
          const first = block?.rows[0];
          if (first !== undefined) jumpTo(first.message.id);
        }}
      />
    </div>
  );
}

/** One group's chat, as in a channel: requests, each member's answers and the tasks between. */
export function AssistantGroupChat(props: {
  readonly environmentId: EnvironmentId;
  readonly teamId: AssistantTeamId;
  /** A link's request to open, in its tab; `onFocused` drops it once handled. */
  readonly focusRequest?: string | undefined;
  readonly focusTab?: string | undefined;
  readonly onFocused?: () => void;
}) {
  const { environmentId, teamId } = props;
  const entries = useAssistantEntries();
  const actions = useAssistantGroupActions(environmentId);
  const flows = useAssistantTeamFlows(environmentId);
  // The reply being written, for the tab it was opened in.
  const [replyPick, setReplyPick] = useState<AssistantGroupTabPick<ReplyTarget> | null>(null);
  const [memberModel, setMemberModel] = useState<Assistant | null>(null);
  const [projectModelOpen, setProjectModelOpen] = useState(false);
  // The composer's model for the next message only; it never saves a default.
  const [modelPick, setModelPick] = useState<AssistantGroupTabPick<ModelSelection> | null>(null);
  // The composer's own project pick, until a send or another tab.
  const [composerPick, setComposerPick] = useState<AssistantGroupProjectPick | null>(null);
  const feedHandle = useRef<GroupFeedHandle>(null);
  const [savedTab, setSavedTab] = useLocalStorage(
    groupTabStorageKey(environmentId, teamId),
    null,
    SavedGroupTab,
  );
  const projects = useProjects().filter((project) => project.environmentId === environmentId);

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
  // Until members and projects arrive, tabs may only be missing: no feed, so nothing reads unscoped.
  const { pending, tabs, tab, scope } = assistantGroupTabView({
    team,
    members,
    projects,
    assistants: byId,
    saved: savedTab,
  });
  const tabKey = tab?.key ?? null;
  // Another tab, chosen or not (a saved tab loading, a removed one), drops the picks for good,
  // and an open reply, which would answer a request out of view; the draft itself stays.
  const heldModelPick = assistantGroupTabPick(modelPick, tabKey);
  if (heldModelPick !== modelPick) setModelPick(null);
  if (assistantGroupTabPick(composerPick, tabKey) !== composerPick) setComposerPick(null);
  if (assistantGroupTabPick(replyPick, tabKey) !== replyPick) setReplyPick(null);
  const replyTo = assistantGroupTabPick(replyPick, tabKey)?.value ?? null;
  const setReplyTo = (target: ReplyTarget | null) =>
    setReplyPick(target === null ? null : { tab: tabKey, value: target });
  const live = useAssistantGroupChat(environmentId, teamId, scope);
  useShowGroupTab(environmentId, teamId, pending ? undefined : tabKey);
  const { focusRequest, focusTab } = props;
  const focused = useStableCallback(() => props.onFocused?.());
  const wantedTab = tabs?.some((entry) => entry.key === focusTab) ? focusTab! : "all";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a link's one-shot intent from the URL
  useEffect(() => {
    if (focusRequest === undefined || pending || live === null) return;
    if (tabKey !== null && tabKey !== wantedTab) {
      setSavedTab(wantedTab);
      return;
    }
    feedHandle.current?.goToRequest(focusRequest);
    focused();
  }, [focusRequest, wantedTab, pending, live, tabKey, setSavedTab, focused]);
  const groupProjectIds = assistantGroupProjectIds(members, team?.projectIds ?? []);
  const projectName = (id: ProjectId) =>
    assistantGroupProjectLabel(
      id,
      projects,
      team?.chat?.scopes,
      groupProjectIds,
      team?.chat?.removedProjectIds,
    );
  const groupProjects: ReadonlyArray<GroupProjectOption> = assistantGroupComposerProjects(
    groupProjectIds,
    projects,
  ).map((id) => ({ id, label: projectName(id) }));
  const sentByUser =
    live === null
      ? []
      : [...live.messages.values()]
          .filter((message) => message.author === "user" && message.kind === "message")
          .sort((left, right) => left.seq - right.seq)
          .map((message) => ({ id: message.id, text: message.text }));
  // A project tab sends there; All, General and a removed project's tab leave it to the lead.
  const groupComposerProject = assistantGroupComposerProject({
    pick: composerPick,
    tab,
    replying: replyTo !== null,
    groupProjects,
  });
  // The project the next message runs in: a reply's request project, else the composer's.
  const modelProjectId = replyTo?.projectId ?? groupComposerProject;
  const modelProject =
    modelProjectId === null ? null : { id: modelProjectId, label: projectName(modelProjectId) };
  const teamModel =
    team === undefined || modelProjectId === null
      ? null
      : (teamModelLayer(team, members, modelProjectId) ?? null);
  const archived = team?.archivedAt != null;
  // Only a pick the chip shows goes with the send.
  const messageModel = modelProjectId === null ? undefined : heldModelPick?.value;

  const send = async (
    text: string,
    attachments: ReadonlyArray<ChatAttachment>,
    requestId: string,
  ): Promise<GroupSendResult> => {
    const reply = await actions.post({
      teamId,
      text,
      clientRequestId: requestId,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(replyTo === null ? {} : { replyToMessageId: replyTo.id }),
      // A reply stays in its request's project; only a request with none can be given one.
      ...(groupComposerProject === null || replyTo?.projectId != null
        ? {}
        : { projectId: groupComposerProject }),
      ...(messageModel === undefined ? {} : { modelSelection: messageModel }),
    });
    if (reply.ok) return { ok: true };
    return {
      ok: false,
      message:
        // A refusal for want of a mention carries the server's why (the lead's model cannot route).
        reply.reason === "archived"
          ? "This group is archived. Restore it to write here."
          : reply.message,
    };
  };

  // One way a send lands, by its reply or by the chat showing its post.
  const landed = (sent: GroupLandedSend) => {
    feedHandle.current?.followEnd();
    // A reply or tab the user opened while the post was on its way stays.
    setReplyPick((current) => assistantGroupLandedPick(current, sent.routing?.reply ?? null));
    setComposerPick((current) =>
      assistantGroupLandedPick(current, sent.routing?.projectPick ?? null),
    );
    setModelPick((current) => assistantGroupLandedPick(current, sent.routing?.modelPick ?? null));
    // A send that lands in another tab's project takes the user there, so it never vanishes.
    if (tabs !== null && sent.tab !== null) {
      const from = sent.tab;
      setSavedTab(
        (saved) => assistantGroupTabAfterSend(tabs, from, saved, sent.projectId) ?? saved,
      );
    }
  };
  const restore = (routing: GroupSendRouting) => {
    setReplyPick(routing.reply);
    setComposerPick(routing.projectPick);
    setModelPick(routing.modelPick);
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
        {tabs === null || tab === null ? null : (
          <GroupTabs
            tabs={tabs}
            active={tab.key}
            projects={projects}
            detail={(entry) =>
              team.chat === undefined
                ? []
                : folderIndicatorDetail({
                    chat: {
                      ...team.chat,
                      scopes: (team.chat.scopes ?? []).filter(
                        (chatScope) =>
                          entry.scope === undefined ||
                          chatScope.projectId === entry.scope.projectId,
                      ),
                    },
                    projects,
                    groupProjectIds,
                  })
            }
            onSelect={setSavedTab}
          />
        )}
        {pending ? (
          <div className="min-h-0 flex-1" />
        ) : (
          <GroupFeed
            key={tabKey ?? "chat"}
            handle={feedHandle}
            environmentId={environmentId}
            team={team}
            tab={tab}
            live={live}
            members={members}
            byId={byId}
            projects={projects}
            groupProjects={groupProjects}
            archived={archived}
            onReply={setReplyTo}
          />
        )}
        <GroupComposer
          key={`${environmentId}:${team.id}`}
          draftKey={`${environmentId}:${team.id}`}
          tab={tabKey}
          environmentId={environmentId}
          members={members}
          leadId={team.leadId}
          disabled={archived || !actions.canPost}
          disabledReason={archived ? "Restore the group to write here" : null}
          projects={groupProjects}
          projectId={groupComposerProject}
          onProjectChange={(projectId) => setComposerPick({ tab: tabKey, value: projectId })}
          teamDefault={teamModel}
          messageModel={{
            pick: heldModelPick,
            tab: tabKey,
            onPick: (selection) =>
              setModelPick(selection === null ? null : { tab: tabKey, value: selection }),
          }}
          replyingTo={replyTo?.quote ?? null}
          chat={{
            teamId,
            scope,
            reply:
              replyTo === null
                ? null
                : { id: replyTo.id, to: replyTo.quote.to, projectId: replyTo.projectId },
          }}
          onJumpToReply={() => replyTo !== null && feedHandle.current?.jumpTo(replyTo.id)}
          onClearReply={() => setReplyTo(null)}
          routing={{ reply: replyPick, projectPick: composerPick, modelPick }}
          onLanded={landed}
          onRestore={restore}
          history={sentByUser}
          messages={live?.messages}
          state={live}
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
          // A tab loads only its own requests; the team's count covers the whole group.
          running={
            team.chat?.runningCount ?? (live === null ? 0 : assistantGroupRunningCount(live))
          }
          modelProject={modelProject}
          onProjectModel={() => setProjectModelOpen(true)}
          onMemberModel={setMemberModel}
        />
      )}
      {body()}
      {!projectModelOpen || modelProject === null ? null : (
        <ProjectModelDialog
          environmentId={environmentId}
          projectId={modelProject.id}
          projectLabel={modelProject.label}
          teamDefault={teamModel}
          onClose={() => setProjectModelOpen(false)}
        />
      )}
      {memberModel === null || modelProject === null ? null : (
        <MemberProjectModelDialog
          environmentId={environmentId}
          projectId={modelProject.id}
          projectLabel={modelProject.label}
          member={memberModel}
          teamDefault={teamModel}
          onClose={() => setMemberModel(null)}
        />
      )}
    </SidebarInset>
  );
}
