import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { Spinner } from "~/components/ui/spinner";
import { ArchiveIcon, ArchiveX, ArchiveRestoreIcon } from "lucide-react";
import { useAssistantActions, useAssistantEntries } from "../../state/assistants";
import {
  assistantIdFromThreadId,
  type Assistant,
  type EnvironmentId,
  type ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useSettingsScope } from "./SettingsScopeContext";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";

/** An old assistant conversation comes back as the assistant's current one, not as a loose thread. */
function RestoreToAssistantButton(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
  readonly threadId: ThreadId;
  readonly disabled: boolean;
  readonly onRestored: () => void;
}) {
  const actions = useAssistantActions(props.environmentId);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      disabled={props.disabled || !actions.canAct}
      onClick={() => {
        void (async () => {
          const reply = await actions.reset({
            assistantId: props.assistant.id,
            restoreThreadId: props.threadId,
          });
          if (reply.ok) {
            props.onRestored();
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to restore the conversation",
              description: reply.message,
            }),
          );
        })();
      }}
    >
      <ArchiveRestoreIcon className="size-3.5" />
      <span>Restore to {props.assistant.name}</span>
    </Button>
  );
}

export function ArchivedThreadsPanel() {
  const assistantEntries = useAssistantEntries();
  const assistantByKey = new Map<string, Assistant>(
    [...assistantEntries.active, ...assistantEntries.archived].map(
      (entry) => [`${entry.environmentId}:${entry.assistant.id}`, entry.assistant] as const,
    ),
  );
  const assistantOfThread = (environmentId: EnvironmentId, threadId: ThreadId) => {
    const assistantId = assistantIdFromThreadId(threadId);
    return assistantId === null
      ? null
      : (assistantByKey.get(`${environmentId}:${assistantId}`) ?? null);
  };
  const { scope, groups: projectGroups, environments } = useSettingsScope();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(scope.environmentIds);

  const { groups: archivedGroups, hasMultipleEnvironments } = (() => {
    const selectedProjectKeys =
      scope.kind === "project" || scope.kind === "checkout"
        ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
        : null;
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects
          .filter(
            (project) =>
              selectedProjectKeys === null ||
              selectedProjectKeys.has(`${environmentId}:${project.id}`),
          )
          .map(
            (project) => [`${environmentId}:${project.id}`, { ...project, environmentId }] as const,
          ),
      ),
    );
    const environmentLabels = new Map(
      environments.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return [environment.environmentId, secondary ? `${primary} (${secondary})` : primary];
      }),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads
        // An archived assistant's current conversation is managed from Settings > Assistants.
        .filter((thread) => assistantOfThread(environmentId, thread.id)?.threadId !== thread.id)
        .map((thread) => ({
          ...presentThreadShell(environmentId, thread),
          environmentLabel: environmentLabels.get(environmentId) ?? environmentId,
        })),
    );
    const hasMultipleEnvironments =
      new Set(
        threads
          .filter((thread) =>
            projectsByEnvironmentAndId.has(`${thread.environmentId}:${thread.projectId}`),
          )
          .map((thread) => thread.environmentId),
      ).size > 1;
    const logicalGroupsByProjectKey = new Map(
      projectGroups.flatMap((group) =>
        group.memberProjectRefs.map(
          (member) => [`${member.environmentId}:${member.projectId}`, group] as const,
        ),
      ),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups = new Map<
      string,
      {
        readonly project: (typeof archivedProjects)[number];
        readonly title: string;
        readonly threads: Array<(typeof threads)[number]>;
      }
    >();
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        const physicalProjectKey = `${project.environmentId}:${project.id}` as const;
        const logicalGroup = hasMultipleEnvironments
          ? logicalGroupsByProjectKey.get(physicalProjectKey)
          : undefined;
        const groupKey = logicalGroup?.projectKey ?? physicalProjectKey;
        const group = groups.get(groupKey);
        if (group) {
          group.threads.push(...projectThreads);
        } else {
          groups.set(groupKey, {
            project,
            title: logicalGroup?.displayName ?? project.title,
            threads: projectThreads,
          });
        }
      }
    }
    const sortedGroups = Array.from(groups, ([key, group]) => ({
      ...group,
      key,
      threads: group.threads.toSorted((left, right) => {
        const leftKey = left.archivedAt ?? left.createdAt;
        const rightKey = right.archivedAt ?? right.createdAt;
        return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
      }),
    }));
    return { groups: sortedGroups, hasMultipleEnvironments };
  })();

  const handleArchivedThreadContextMenu = async (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        ...(assistantIdFromThreadId(threadRef.threadId) === null
          ? [{ id: "unarchive" as const, label: "Unarchive" }]
          : []),
        { id: "delete" as const, label: "Delete", destructive: true },
      ],
      position,
    );

    if (clicked === "unarchive") {
      const result = await unarchiveThread(threadRef);
      if (result._tag === "Success") {
        refreshArchivedThreads();
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to unarchive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return;
    }

    if (clicked === "delete") {
      const result = await confirmAndDeleteThread(threadRef);
      if (result._tag === "Success") {
        refreshArchivedThreads();
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    }
  };

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={searchableSetting("archive").title}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "Loading archived threads"
                  : archiveError
                    ? "Could not load archived threads"
                    : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : (archiveError ?? "Archived threads will appear here.")
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ key, project, title, threads: projectThreads }, index) => (
          <SettingsSection
            key={key}
            id={index === 0 ? searchableSetting("archive").id : undefined}
            title={title}
            icon={<ProjectFavicon project={project} />}
          >
            {projectThreads.map((thread) => {
              const assistant =
                assistantIdFromThreadId(thread.id) === null
                  ? null
                  : assistantOfThread(thread.environmentId, thread.id);
              return (
                <SettingsRow
                  key={`${thread.environmentId}:${thread.id}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void (async () => {
                      const result = await settlePromise(() =>
                        handleArchivedThreadContextMenu(
                          scopeThreadRef(thread.environmentId, thread.id),
                          {
                            x: event.clientX,
                            y: event.clientY,
                          },
                        ),
                      );
                      if (result._tag === "Failure") {
                        const error = squashAtomCommandFailure(result);
                        toastManager.add(
                          stackedThreadToast({
                            type: "error",
                            title: "Archived thread action failed",
                            description:
                              error instanceof Error ? error.message : "An error occurred.",
                          }),
                        );
                      }
                    })();
                  }}
                  title={thread.title}
                  description={
                    <span className={hasMultipleEnvironments ? "block truncate" : undefined}>
                      {hasMultipleEnvironments ? `${thread.environmentLabel} · ` : null}
                      Archived <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />
                      {" \u00b7 Created "}
                      <RelativeTime timestamp={thread.createdAt} />
                    </span>
                  }
                  control={
                    assistantIdFromThreadId(thread.id) !== null ? (
                      assistant ? (
                        <RestoreToAssistantButton
                          environmentId={thread.environmentId}
                          assistant={assistant}
                          threadId={thread.id}
                          disabled={assistant.archivedAt !== null}
                          onRestored={refreshArchivedThreads}
                        />
                      ) : null
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => {
                          void (async () => {
                            const result = await unarchiveThread(
                              scopeThreadRef(thread.environmentId, thread.id),
                            );
                            if (result._tag === "Success") {
                              refreshArchivedThreads();
                              return;
                            }
                            if (!isAtomCommandInterrupted(result)) {
                              const error = squashAtomCommandFailure(result);
                              toastManager.add(
                                stackedThreadToast({
                                  type: "error",
                                  title: "Failed to unarchive thread",
                                  description:
                                    error instanceof Error ? error.message : "An error occurred.",
                                }),
                              );
                            }
                          })();
                        }}
                      >
                        <ArchiveX className="size-3.5" />
                        <span>Unarchive</span>
                      </Button>
                    )
                  }
                />
              );
            })}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
