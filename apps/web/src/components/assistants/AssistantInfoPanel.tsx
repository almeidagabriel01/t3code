import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  assistantGroupRunningTasks,
  ASSISTANT_GROUP_STATUS_LABEL,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  assistantAskBeforeActingLabel,
  assistantGroupInfoSummary,
  assistantGroupMembers,
  assistantInfoGroups,
  assistantInfoProjects,
} from "@t3tools/client-runtime/assistantInfo";
import {
  assistantWorkingHereLabel,
  assistantWorkingNow,
} from "@t3tools/client-runtime/assistantLiveWork";
import { assistantFace } from "@t3tools/client-runtime/assistantRobot";
import { PROBLEM_LEVEL_LEGEND, problemLevelLabel } from "@t3tools/client-runtime/autonomy";
import { assistantProjectsChip } from "@t3tools/client-runtime/assistantSections";
import { ASSISTANT_TASK_STATE_LABEL } from "@t3tools/client-runtime/assistantTasks";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BrainIcon,
  BriefcaseIcon,
  GaugeIcon,
  KeyRoundIcon,
  MessageCircleQuestionIcon,
  WrenchIcon,
  CalendarClockIcon,
  HashIcon,
  LayersIcon,
  MessagesSquareIcon,
  PencilIcon,
  ScrollTextIcon,
  SettingsIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useId, type ReactNode } from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import {
  type AssistantEntry,
  type AssistantTeamEntry,
  useAssistantEntries,
  useAssistantGroupChat,
  useAssistantLiveWork,
  useAssistantSpend,
} from "../../state/assistants";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { modelSelectionDisplayName } from "../chat/providerIconUtils";
import { useAssistantStatus } from "../sidebar/useSidebarZones";
import { useUsageLimitLabel } from "./useUsageLimitLabel";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Sheet, SheetPopup } from "../ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { spendLine } from "./assistantBudget";
import { openAssistantDialog } from "./assistantDialogState";
import { assistantInfoAtom, closeAssistantInfo, openAssistantInfo } from "./assistantInfoState";
import {
  AssistantAvatar,
  AssistantCluster,
  assistantStatusText,
  MOOD_TEXT,
  removedAssistantFace,
  toolAccessLabel,
} from "./assistantPresentation";
import {
  openAssistantGroupRoutines,
  openAssistantGroupSettings,
  openAssistantTeamDialog,
} from "./assistantTeamState";
import { openAssistantWork } from "./assistantWorkState";
import { AssistantEnvironmentField } from "./AssistantEnvironmentField";
import { useAssistantFlows, useAssistantTeamFlows } from "./useAssistantFlows";

const ROW =
  "flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const ACTIVE_ROW = `${ROW} cursor-pointer hover:bg-foreground/8`;

function ActionRow(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        ACTIVE_ROW,
        "disabled:pointer-events-none disabled:opacity-64",
        props.destructive && "hover:text-destructive",
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      {props.label}
    </button>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={props.title} className="flex min-w-0 flex-col gap-1">
      <h3 className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {props.title}
      </h3>
      <ul className="m-0 flex min-w-0 flex-col p-0">{props.children}</ul>
    </section>
  );
}

function Hero(props: {
  readonly face: ReactNode;
  readonly name: string;
  readonly role?: string;
  readonly status: string;
  readonly statusClass: string;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-1 px-2 pt-2 text-center">
      {props.face}
      <p className="mt-2 max-w-full truncate text-lg font-semibold" data-assistant-info-name>
        {props.name}
      </p>
      {props.role ? (
        <p className="max-w-full truncate text-sm text-muted-foreground">{props.role}</p>
      ) : null}
      <p
        data-assistant-info-status
        className={cn("max-w-full truncate text-xs", props.statusClass)}
      >
        {props.status}
      </p>
    </div>
  );
}

function Actions(props: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-3 gap-2 px-2">{props.children}</div>;
}

function useProjectLookup() {
  const projects = useProjects();
  return (environmentId: string, projectId: string) =>
    projects.find(
      (project) => project.environmentId === environmentId && project.id === projectId,
    ) ?? null;
}

function AssistantInfo(props: { readonly entry: AssistantEntry }) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const navigate = useNavigate();
  const shells = useQuietThreadShells();
  const status = useAssistantStatus();
  const limitLabel = useUsageLimitLabel();
  const work = useAssistantLiveWork();
  const nowMs = useNowMinuteMs();
  const { teams } = useAssistantEntries();
  const projectOf = useProjectLookup();
  const spend = useAssistantSpend(environmentId, assistant.budget === null ? null : assistant.id);
  const providers = useEnvironmentProviders().get(environmentId);
  const archived = assistant.archivedAt !== null;
  const presence = status.of(environmentId, assistant, limitLabel);
  const workingNow = archived ? [] : assistantWorkingNow(work, environmentId, assistant.id);
  const nameOf = (projectId: string) => projectOf(environmentId, projectId)?.title ?? "Project";
  const projects = assistantInfoProjects(assistant, workingNow, nameOf);
  const groups = assistantInfoGroups(
    teams.filter((entry) => entry.environmentId === environmentId),
    assistant.id,
  );
  const thread = shells.find(
    (shell) => shell.environmentId === environmentId && shell.id === assistant.threadId,
  );
  const shellOf = (threadId: string) =>
    shells.find((shell) => shell.environmentId === environmentId && shell.id === threadId);
  const openThread = (threadId: string) => {
    closeAssistantInfo();
    flows.openThread(scopeThreadRef(environmentId, threadId as never));
  };
  return (
    <>
      <Hero
        face={
          <AssistantAvatar
            assistant={assistant}
            environmentId={environmentId}
            mood={archived ? "sleeping" : assistantFace(presence, nowMs)}
            animated
            className="size-20"
          />
        }
        name={assistant.name}
        role={assistant.role}
        status={archived ? "Archived" : assistantStatusText(presence, nowMs)}
        statusClass={archived ? MOOD_TEXT.idle : MOOD_TEXT[presence.mood]}
      />
      <Actions>
        <Button
          variant="outline"
          size="sm"
          disabled={assistant.threadId === null}
          onClick={() => {
            closeAssistantInfo();
            flows.openConversation(assistant);
          }}
        >
          <MessagesSquareIcon />
          Open chat
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openAssistantDialog({ environmentId, assistantId: assistant.id })}
        >
          <SettingsIcon />
          Edit
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openAssistantWork({ environmentId, assistantId: assistant.id })}
        >
          <BriefcaseIcon />
          Work
        </Button>
      </Actions>
      {archived ? null : (
        <Section title="Working now">
          {workingNow.length === 0 ? (
            <li className={cn(ROW, "list-none text-muted-foreground")}>Nothing running</li>
          ) : (
            workingNow.map((site) => {
              const title = shellOf(site.threadId)?.title ?? "";
              const state =
                ASSISTANT_TASK_STATE_LABEL[site.face === "waiting" ? "waiting" : "running"];
              return (
                <li key={site.threadId} className="list-none">
                  <button
                    type="button"
                    data-testid="assistant-info-working"
                    className={ACTIVE_ROW}
                    onClick={() => openThread(site.threadId)}
                  >
                    <AssistantAvatar assistant={assistant} mood={site.face} className="size-6" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {nameOf(site.projectId)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        site.face === "waiting" ? MOOD_TEXT.needs : MOOD_TEXT.working,
                      )}
                    >
                      {state}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </Section>
      )}
      <Section title="Projects">
        {projects.all ? (
          <li className={cn(ROW, "list-none")}>
            <LayersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            All projects
          </li>
        ) : null}
        {projects.rows.map((row) => {
          const project = projectOf(environmentId, row.projectId);
          return (
            <li
              key={row.projectId}
              className={cn(ROW, "list-none")}
              data-testid="assistant-info-project"
            >
              {project ? (
                <ProjectFavicon project={project} className="size-4" />
              ) : (
                <LayersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {row.workingNow ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        role="img"
                        aria-label={assistantWorkingHereLabel(assistant.name)}
                        className="size-2 shrink-0 rounded-full bg-info"
                      />
                    }
                  />
                  <TooltipPopup side="top">
                    {assistantWorkingHereLabel(assistant.name)}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </li>
          );
        })}
      </Section>
      {groups.length === 0 ? null : (
        <Section title="Groups">
          {groups.map(({ entry, lead }) => (
            <li key={entry.team.id} className="list-none">
              <button
                type="button"
                className={ACTIVE_ROW}
                onClick={() => {
                  closeAssistantInfo();
                  void navigate({
                    to: "/group/$environmentId/$teamId",
                    params: { environmentId, teamId: entry.team.id },
                  });
                }}
              >
                <HashIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{entry.team.name}</span>
                {lead ? (
                  <Badge variant="info" size="sm">
                    Lead
                  </Badge>
                ) : null}
              </button>
            </li>
          ))}
        </Section>
      )}
      <Section title="Access">
        <InfoField
          icon={KeyRoundIcon}
          label="Tool access"
          value={toolAccessLabel(assistant.toolAccess)}
        />
        <InfoField
          icon={MessageCircleQuestionIcon}
          label="Asks before acting"
          value={assistantAskBeforeActingLabel(assistant.askBeforeActing)}
        />
        {thread ? (
          <InfoField
            icon={BrainIcon}
            label="Model"
            value={modelSelectionDisplayName(providers, thread.modelSelection)}
          />
        ) : null}
        <InfoField
          icon={WrenchIcon}
          label={PROBLEM_LEVEL_LEGEND}
          value={problemLevelLabel(assistant.autonomy.onProblem)}
        />
        {assistant.budget !== null && spend ? (
          <InfoField icon={GaugeIcon} label="Spending limit" value={spendLine(spend)} />
        ) : null}
      </Section>
      <div className="px-2">
        <AssistantEnvironmentField
          environmentId={environmentId}
          value={assistant.defaultEnvironment}
          workspace={assistant.workspace}
          scope={assistant.scope}
          disabled={archived || !flows.canAct}
          onChange={(next) => void flows.setDefaultEnvironment(assistant, next)}
        />
      </div>
      {archived ? (
        <ActionRow
          icon={ArchiveRestoreIcon}
          label="Restore"
          disabled={!flows.canAct}
          onClick={() => void flows.unarchive(assistant)}
        />
      ) : (
        <ActionRow
          icon={ArchiveIcon}
          label="Archive assistant"
          destructive
          disabled={!flows.canAct}
          onClick={() => void flows.archive(assistant)}
        />
      )}
    </>
  );
}

function InfoField(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: string;
}) {
  const Icon = props.icon;
  return (
    <li className={cn(ROW, "list-none")}>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{props.label}</span>
      <span className="min-w-0 flex-1 truncate text-end">{props.value}</span>
    </li>
  );
}

function GroupInfo(props: { readonly entry: AssistantTeamEntry }) {
  const { team, environmentId } = props.entry;
  const flows = useAssistantTeamFlows(environmentId);
  const navigate = useNavigate();
  const shells = useQuietThreadShells();
  const status = useAssistantStatus();
  const limitLabel = useUsageLimitLabel();
  const { active, archived: archivedAssistants } = useAssistantEntries();
  const chat = useAssistantGroupChat(environmentId, team.id);
  const projectOf = useProjectLookup();
  const archived = team.archivedAt !== null;
  const assistants = [...active, ...archivedAssistants]
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.assistant);
  const members = assistantGroupMembers(team, assistants);
  const running = chat === null ? [] : assistantGroupRunningTasks(chat);
  const nameOf = (projectId: string) => projectOf(environmentId, projectId)?.title ?? "Project";
  const memberFace = (id: string) =>
    members.find((member) => member.id === id)?.assistant ?? removedAssistantFace(id);
  const openChat = () => {
    closeAssistantInfo();
    void navigate({
      to: "/group/$environmentId/$teamId",
      params: { environmentId, teamId: team.id },
    });
  };
  return (
    <>
      <Hero
        face={
          <AssistantCluster
            environmentId={environmentId}
            className="size-20"
            faces={members.map((member) => ({
              key: member.id,
              assistant: member.assistant ?? removedAssistantFace(member.id),
              mood: member.assistant
                ? assistantFace(status.of(environmentId, member.assistant))
                : "sleeping",
            }))}
          />
        }
        name={team.name}
        status={archived ? "Archived" : assistantGroupInfoSummary(members.length, running.length)}
        statusClass={MOOD_TEXT.idle}
      />
      <Actions>
        <Button variant="outline" size="sm" onClick={openChat}>
          <MessagesSquareIcon />
          Open chat
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openAssistantTeamDialog({ environmentId, teamId: team.id })}
        >
          <PencilIcon />
          Edit group
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openAssistantGroupSettings({ environmentId, teamId: team.id })}
        >
          <SettingsIcon />
          Group settings
        </Button>
      </Actions>
      {archived ? null : (
        <Section title="Working now">
          {running.length === 0 ? (
            <li className={cn(ROW, "list-none text-muted-foreground")}>Nothing running</li>
          ) : (
            running.map((task) => {
              const shell = shells.find(
                (candidate) =>
                  candidate.environmentId === environmentId && candidate.id === task.threadId,
              );
              return (
                <li key={task.id} className={cn(ROW, "list-none")} data-testid="group-info-working">
                  <AssistantAvatar
                    assistant={memberFace(task.ownerId)}
                    mood="working"
                    className="size-6"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{task.instruction}</span>
                    {shell ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {nameOf(shell.projectId)}
                      </span>
                    ) : null}
                  </span>
                  <span className={cn("shrink-0 text-xs", MOOD_TEXT.working)}>
                    {ASSISTANT_GROUP_STATUS_LABEL[task.status]}
                  </span>
                </li>
              );
            })
          )}
        </Section>
      )}
      <Section title="Members">
        {members.map((member) => {
          const presence = status.of(environmentId, member.assistant, limitLabel);
          const face = (
            <AssistantAvatar
              assistant={member.assistant ?? removedAssistantFace(member.id)}
              environmentId={environmentId}
              mood={member.assistant ? assistantFace(presence) : "sleeping"}
              className="size-7"
            />
          );
          const body = (
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate">{member.assistant?.name ?? "Assistant"}</span>
                {member.lead ? (
                  <Badge variant="info" size="sm">
                    Lead
                  </Badge>
                ) : null}
              </span>
              {member.assistant ? (
                <span className="truncate text-xs text-muted-foreground">
                  <span className={MOOD_TEXT[presence.mood]}>{presence.detail}</span>
                  {` · ${assistantProjectsChip(member.assistant, nameOf)}`}
                </span>
              ) : null}
            </span>
          );
          const memberAssistant = member.assistant;
          return (
            <li key={member.id} className="list-none" data-testid="group-info-member">
              {memberAssistant ? (
                <button
                  type="button"
                  className={ACTIVE_ROW}
                  onClick={() =>
                    openAssistantInfo({
                      kind: "assistant",
                      environmentId,
                      assistantId: memberAssistant.id,
                    })
                  }
                >
                  {face}
                  {body}
                </button>
              ) : (
                <div className={ROW}>
                  {face}
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </Section>
      <div className="px-2">
        <AssistantEnvironmentField
          environmentId={environmentId}
          value={team.defaultEnvironment}
          disabled={archived || !flows.canAct}
          onChange={(next) => void flows.setDefaultEnvironment(team, next)}
        />
      </div>
      <ul className="m-0 flex flex-col p-0">
        {(
          [
            [
              "Instructions",
              ScrollTextIcon,
              () => openAssistantGroupSettings({ environmentId, teamId: team.id }),
            ],
            [
              "Memories",
              BrainIcon,
              () => openAssistantGroupSettings({ environmentId, teamId: team.id }),
            ],
            [
              "Routines",
              CalendarClockIcon,
              () => openAssistantGroupRoutines({ environmentId, teamId: team.id }),
            ],
          ] as const
        ).map(([label, Icon, onOpen]) => (
          <li key={label} className="list-none">
            <ActionRow icon={Icon} label={label} onClick={onOpen} />
          </li>
        ))}
      </ul>
      {archived ? (
        <ActionRow
          icon={ArchiveRestoreIcon}
          label="Restore group"
          disabled={!flows.canAct}
          onClick={() => void flows.restore(team)}
        />
      ) : (
        <ActionRow
          icon={ArchiveIcon}
          label="Archive group"
          destructive
          disabled={!flows.canAct}
          onClick={() => void flows.archive(team)}
        />
      )}
    </>
  );
}

/**
 * Assistant info and Group info: a panel beside the chat, so the chat stays usable while it is
 * open. It closes with Esc, its close button or its trigger, and when its subject is deleted.
 */
export function AssistantInfoPanel() {
  const target = useAtomValue(assistantInfoAtom);
  const { active, archived, teams } = useAssistantEntries();
  const titleId = useId();
  const assistantEntry =
    target?.kind === "assistant"
      ? ([...active, ...archived].find(
          (entry) =>
            entry.environmentId === target.environmentId &&
            entry.assistant.id === target.assistantId,
        ) ?? null)
      : null;
  const teamEntry =
    target?.kind === "group"
      ? (teams.find(
          (entry) =>
            entry.environmentId === target.environmentId && entry.team.id === target.teamId,
        ) ?? null)
      : null;
  const open = assistantEntry !== null || teamEntry !== null;
  return (
    <Sheet
      open={open}
      modal={false}
      disablePointerDismissal
      onOpenChange={(next) => {
        if (!next) closeAssistantInfo();
      }}
    >
      <SheetPopup
        side="right"
        backdrop={false}
        showCloseButton={false}
        aria-labelledby={titleId}
        data-testid="assistant-info-panel"
        data-glass-pane="pane"
        className="mt-(--workspace-topbar-height) h-[calc(100%-var(--workspace-topbar-height))] max-h-[calc(100%-var(--workspace-topbar-height))]"
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 ps-4 pe-2">
          <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold">
            {teamEntry ? "Group info" : "Assistant info"}
          </h2>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Close"
                  onClick={closeAssistantInfo}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Close</TooltipPopup>
          </Tooltip>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pb-6">
          {assistantEntry ? (
            <AssistantInfo
              key={`${assistantEntry.environmentId}:${assistantEntry.assistant.id}`}
              entry={assistantEntry}
            />
          ) : null}
          {teamEntry ? (
            <GroupInfo key={`${teamEntry.environmentId}:${teamEntry.team.id}`} entry={teamEntry} />
          ) : null}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
