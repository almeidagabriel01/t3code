import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { assistantPresence } from "@t3tools/client-runtime/assistantRobot";
import { assistantEntryKey, assistantSections } from "@t3tools/client-runtime/assistantSections";
import type { AssistantTeamId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ArchiveRestoreIcon, ArchiveIcon, PlusIcon, SettingsIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import {
  type AssistantEntry,
  type AssistantTeamEntry,
  useAssistantEntries,
  useAssistantsEnvironmentIds,
} from "../../state/assistants";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { WorkspaceBreadcrumb } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { openAssistantDialog } from "./assistantDialogState";
import { AssistantAvatar } from "./assistantPresentation";
import { openAssistantTeamDialog } from "./assistantTeamState";
import { useAssistantFlows } from "./useAssistantFlows";

const MOOD_TEXT = {
  idle: "text-muted-foreground",
  working: "text-info-foreground",
  needs: "text-warning-foreground",
  failed: "text-destructive-foreground",
} as const;

function AssistantCard(props: {
  readonly entry: AssistantEntry;
  readonly groupNames: ReadonlyArray<string>;
  readonly projectLabel: string;
  readonly nowMs: number;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const archived = assistant.archivedAt !== null;
  const threadRef =
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId);
  const presence = assistantPresence(useThreadShell(threadRef));
  const since = presence.since === null ? "" : formatRelativeTimeLabel(presence.since, props.nowMs);
  return (
    <article
      data-testid="assistant-card"
      aria-label={assistant.name}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-foreground/12 bg-card/70 p-3 @lg/assistants:p-4"
    >
      <div className="flex min-w-0 items-start gap-3">
        <AssistantAvatar
          assistant={assistant}
          environmentId={environmentId}
          mood={archived ? "idle" : presence.mood}
          className="size-12"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-sm font-medium">{assistant.name}</h3>
            {assistant.role === "" ? null : (
              <Badge variant="info" size="sm">
                {assistant.role}
              </Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">{props.projectLabel}</p>
          {archived ? (
            <p className="truncate text-xs text-muted-foreground">Archived</p>
          ) : (
            <p className={cn("truncate text-xs", MOOD_TEXT[presence.mood])}>
              {since === "" ? presence.detail : `${presence.detail} · ${since}`}
            </p>
          )}
        </div>
      </div>
      {props.groupNames.length === 0 ? null : (
        <ul aria-label="Groups" className="flex flex-wrap gap-1">
          {props.groupNames.map((name) => (
            <li key={name} className="list-none">
              <Badge variant="outline" size="sm">
                {name}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {archived ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!flows.canAct}
            onClick={() => void flows.unarchive(assistant)}
          >
            <ArchiveRestoreIcon />
            Restore
          </Button>
        ) : (
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={assistant.threadId === null}
              onClick={() => flows.openConversation(assistant)}
            >
              Open thread
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => openAssistantDialog({ environmentId, assistantId: assistant.id })}
            >
              <SettingsIcon />
              Edit
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!flows.canAct}
              onClick={() => void flows.archive(assistant)}
            >
              <ArchiveIcon />
              Archive
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

function Section(props: {
  readonly title: string;
  readonly count?: number;
  readonly actions?: ReactNode;
  readonly empty?: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.title} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-7 items-center gap-2">
        <h2 className="min-w-0 truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {props.title}
        </h2>
        {props.count === undefined ? null : (
          <span className="text-xs text-muted-foreground tabular-nums">{props.count}</span>
        )}
        <span className="ms-auto flex items-center gap-1">{props.actions}</span>
      </div>
      {props.empty === undefined ? (
        <div className="grid gap-3 @xl/assistants:grid-cols-2 @4xl/assistants:grid-cols-3">
          {props.children}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{props.empty}</p>
      )}
    </section>
  );
}

/** Every assistant, grouped like the sidebar, with a card each. */
export function AssistantsPage() {
  const { active, archived, teams } = useAssistantEntries();
  const environmentIds = useAssistantsEnvironmentIds();
  const projects = useProjects();
  const shells = useQuietThreadShells();
  const nowMs = useNowMinuteMs();

  const keyByThread = new Map(
    active.flatMap((entry) =>
      entry.assistant.threadId === null
        ? []
        : [
            [
              scopedThreadKey(scopeThreadRef(entry.environmentId, entry.assistant.threadId)),
              assistantEntryKey(entry),
            ] as const,
          ],
    ),
  );
  const needsKeys = new Set<string>();
  for (const shell of shells) {
    const key = keyByThread.get(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)));
    if (key !== undefined && assistantPresence(shell).mood === "needs") needsKeys.add(key);
  }
  const sections = assistantSections({ assistants: active, teams, needsKeys });

  const projectName = (environmentId: string, projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "Project";
  const groupNamesOf = (entry: AssistantEntry) =>
    teams
      .filter(
        (candidate: AssistantTeamEntry) =>
          candidate.environmentId === entry.environmentId &&
          candidate.team.memberIds.includes(entry.assistant.id),
      )
      .map((candidate) => candidate.team.name);
  const projectLabelOf = (entry: AssistantEntry) =>
    entry.assistant.scope === "project"
      ? projectName(entry.environmentId, entry.assistant.projectId)
      : "All projects";
  const card = (entry: AssistantEntry, keyPrefix: string) => (
    <AssistantCard
      key={`${keyPrefix}:${assistantEntryKey(entry)}`}
      entry={entry}
      groupNames={groupNamesOf(entry)}
      projectLabel={projectLabelOf(entry)}
      nowMs={nowMs}
    />
  );
  const newAssistantHere = (
    environmentId: EnvironmentId,
    preset: { readonly projectId?: ProjectId; readonly teamId?: AssistantTeamId },
  ) => (
    <Button
      size="xs"
      variant="ghost-muted"
      onClick={() => openAssistantDialog({ environmentId, preset })}
    >
      <PlusIcon />
      New assistant here
    </Button>
  );
  const nothing =
    active.length === 0 && archived.length === 0 && teams.length === 0 && environmentIds.length > 0;

  return (
    <SidebarInset className="@container/assistants h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader
        electron={isElectron}
        className="relative bg-background"
        data-glass-layer
      >
        <WorkspaceBreadcrumb ariaLabel="Assistants">
          <h1 className="truncate">Assistants</h1>
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {active.length}
          </span>
        </WorkspaceBreadcrumb>
        {environmentIds.length === 0 ? null : (
          <div className="ms-auto flex items-center gap-1.5">
            <Button size="xs" variant="outline" onClick={() => openAssistantTeamDialog()}>
              <UsersIcon />
              <span className="@max-lg/assistants:sr-only">New group</span>
            </Button>
            <Button size="xs" onClick={() => openAssistantDialog()}>
              <PlusIcon />
              <span className="@max-lg/assistants:sr-only">New assistant</span>
            </Button>
          </div>
        )}
      </WorkspacePageHeader>
      {environmentIds.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Assistants are not available</EmptyTitle>
            <EmptyDescription>
              Connect to a T3 Code server that supports assistants, with permission to read them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : nothing ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No assistants yet</EmptyTitle>
            <EmptyDescription>
              An assistant keeps one long conversation you can come back to. Create one to get
              started.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-6 px-3 py-4 @xl/assistants:px-6 @4xl/assistants:px-10">
            {sections.needs.length === 0 ? null : (
              <Section title="Needs you" count={sections.needs.length}>
                {sections.needs.map((entry) => card(entry, "needs"))}
              </Section>
            )}
            {sections.groups.map(({ team: entry, members }) => (
              <Section
                key={`${entry.environmentId}:${entry.team.id}`}
                title={entry.team.name}
                count={members.length}
                {...(members.length === 0 ? { empty: "No members yet." } : {})}
                actions={
                  <>
                    {newAssistantHere(entry.environmentId as EnvironmentId, {
                      teamId: entry.team.id,
                    })}
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() =>
                        openAssistantTeamDialog({
                          environmentId: entry.environmentId as EnvironmentId,
                          teamId: entry.team.id,
                        })
                      }
                    >
                      Edit group
                    </Button>
                  </>
                }
              >
                {members.map((member) => card(member, `group:${entry.team.id}`))}
              </Section>
            ))}
            {sections.projects.map((project) => (
              <Section
                key={`${project.environmentId}:${project.projectId}`}
                title={projectName(project.environmentId, project.projectId)}
                count={project.members.length}
                actions={newAssistantHere(project.environmentId as EnvironmentId, {
                  projectId: project.projectId as ProjectId,
                })}
              >
                {project.members.map((member) => card(member, `project:${project.projectId}`))}
              </Section>
            ))}
            {sections.unassigned.length === 0 ? null : (
              <Section title="Unassigned" count={sections.unassigned.length}>
                {sections.unassigned.map((entry) => card(entry, "unassigned"))}
              </Section>
            )}
            {archived.length === 0 ? null : (
              <Section title="Archived" count={archived.length}>
                {archived.map((entry) => card(entry, "archived"))}
              </Section>
            )}
          </div>
        </div>
      )}
    </SidebarInset>
  );
}
