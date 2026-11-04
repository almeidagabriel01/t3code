import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { repositoryGroupingKeyOf, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" }
  | { readonly kind: "dismiss" };

/**
 * The copy of a project a new thread starts in: the preferred environment's, then the
 * representative. A connected copy wins over a disconnected one.
 */
export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): EnvironmentProject {
  const rank = (project: EnvironmentProject) =>
    project.environmentId === preferredEnvironmentId ? 0 : project === scope.representative ? 1 : 2;
  const ordered = [...scope.projects].sort((left, right) => rank(left) - rank(right));
  return (
    ordered.find((project) => connectedEnvironmentIds.has(project.environmentId)) ??
    ordered[0] ??
    scope.representative
  );
}

export function filterProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  searchText: string,
): ReadonlyArray<HomeProjectScope> {
  const query = searchText.trim().toLowerCase();
  if (!query) return scopes;
  return scopes.filter(
    (scope) =>
      scope.title.toLowerCase().includes(query) ||
      scope.projects.some(
        (project) =>
          project.title.toLowerCase().includes(query) ||
          project.workspaceRoot.toLowerCase().includes(query),
      ),
  );
}

// Cached configuration reserves the row; connection readiness only gates activation.
export function resolveNewTaskScratchOption(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  }>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "scratchWorkspaceRoot">>;
  readonly selectedEnvironmentId: EnvironmentId | null;
}) {
  const offering = input.environments.filter(
    (environment) =>
      (input.serverConfigs.get(environment.environmentId)?.scratchWorkspaceRoot ?? null) !== null,
  );
  const ready = offering.filter(
    (environment) =>
      availableScratchWorkspaceRoot(
        environment.connectionState,
        input.serverConfigs.get(environment.environmentId),
      ) !== null,
  );
  const candidates = ready.length > 0 ? ready : offering;
  const environment =
    candidates.find((candidate) => candidate.environmentId === input.selectedEnvironmentId) ??
    candidates[0];
  return environment ? { environmentId: environment.environmentId, ready: ready.length > 0 } : null;
}

export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // Use || null: placeholder workspaceRoot can be empty, which supplies no useful basename.
  const workspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  // Use weaker signals only when identity is unknown; different known repositories never match by basename or title.
  const isKnownMismatch = (project: EnvironmentProject) => {
    const projectKey = project.repositoryIdentity
      ? repositoryGroupingKeyOf(project.repositoryIdentity)
      : null;
    return repositoryKey !== null && projectKey !== null && projectKey !== repositoryKey;
  };
  return (
    (repositoryKey !== null
      ? projectsOnTarget.find(
          (project) =>
            (project.repositoryIdentity
              ? repositoryGroupingKeyOf(project.repositoryIdentity)
              : null) === repositoryKey,
        )
      : undefined) ??
    (workspaceBasename !== null
      ? projectsOnTarget.find(
          (project) =>
            !isKnownMismatch(project) &&
            project.workspaceRoot.split("/").at(-1) === workspaceBasename,
        )
      : undefined) ??
    (selectedProject !== null
      ? projectsOnTarget.find(
          (project) => !isKnownMismatch(project) && project.title === selectedProject.title,
        )
      : undefined) ??
    projectsOnTarget[0] ??
    null
  );
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
  draft: {
    readonly incomingShareId: string | undefined;
    /** The draft's first project picker closed and the draft is showing again. */
    readonly pickerClosed: boolean;
  },
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  if (hasExplicitProjectSelection) {
    return { kind: "preserve" };
  }
  // A share draft holds content the user sent here, so cancelling the picker must not drop it.
  if (draft.pickerClosed && selectedProjectKey === null && draft.incomingShareId === undefined) {
    return { kind: "dismiss" };
  }

  const onlyScope =
    draft.incomingShareId !== undefined && projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope ? { kind: "select", project: onlyScope.representative } : { kind: "pick" };
}

/**
 * A new task always asks for the project. The last-used project, when the preference is on,
 * moves to the front of the list and is marked, so it is one tap away.
 */
export function orderScopesByLastProject(
  scopes: ReadonlyArray<HomeProjectScope>,
  preferences:
    | {
        readonly lastThreadProject?: { readonly environmentId: string; readonly projectId: string };
        readonly useLastProjectForNewThreads?: boolean;
      }
    | undefined,
): { readonly scopes: ReadonlyArray<HomeProjectScope>; readonly lastUsedKey: string | null } {
  const lastProject = preferences?.lastThreadProject;
  const last =
    preferences?.useLastProjectForNewThreads === false || !lastProject
      ? undefined
      : scopes.find((scope) =>
          scope.projectRefs.some(
            (ref) =>
              ref.environmentId === lastProject.environmentId &&
              ref.projectId === lastProject.projectId,
          ),
        );
  return last
    ? { scopes: [last, ...scopes.filter((scope) => scope !== last)], lastUsedKey: last.key }
    : { scopes, lastUsedKey: null };
}
