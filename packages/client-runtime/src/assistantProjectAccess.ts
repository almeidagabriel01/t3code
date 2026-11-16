import {
  type Assistant,
  type AssistantTeam,
  assistantEffectiveProjectIds,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";

export type AccessAssistant = Pick<
  Assistant,
  "id" | "name" | "scope" | "projectId" | "projectIds" | "archivedAt"
>;
export type AccessTeam = Pick<
  AssistantTeam,
  "id" | "name" | "memberIds" | "archivedAt" | "projectIds"
>;

const isActiveMember = (team: AccessTeam, assistantId: string) =>
  team.archivedAt === null && team.memberIds.includes(assistantId as Assistant["id"]);

/** The projects an assistant gets from its active groups, each with the groups that give it. */
export function inheritedProjects(
  assistant: AccessAssistant,
  teams: ReadonlyArray<AccessTeam>,
): ReadonlyArray<{
  readonly projectId: ProjectId;
  readonly teamNames: ReadonlyArray<string>;
  /** Also on its own list, so taking it from the groups keeps its access. */
  readonly alsoOwn: boolean;
}> {
  if (assistant.scope !== "project") return [];
  const byProject = new Map<ProjectId, Array<string>>();
  for (const team of teams) {
    if (!isActiveMember(team, assistant.id)) continue;
    for (const projectId of team.projectIds) {
      byProject.set(projectId, [...(byProject.get(projectId) ?? []), team.name]);
    }
  }
  return [...byProject].map(([projectId, teamNames]) => ({
    projectId,
    teamNames,
    alsoOwn: assistant.projectIds.includes(projectId),
  }));
}

/**
 * How many active members of `team` cannot yet reach a project in `projectIds`. Members that work
 * everywhere never gain anything.
 */
export function membersGainingAccess(
  team: AccessTeam,
  projectIds: ReadonlyArray<string>,
  assistants: ReadonlyArray<AccessAssistant>,
  teams: ReadonlyArray<AccessTeam>,
): number {
  return assistants.filter((assistant) => {
    if (assistant.archivedAt !== null || !team.memberIds.includes(assistant.id)) return false;
    if (assistant.scope !== "project") return false;
    const reach: ReadonlyArray<string> = assistantEffectiveProjectIds(assistant, teams);
    return projectIds.some((projectId) => !reach.includes(projectId));
  }).length;
}

/** How an assistant reaches a project: every project, its own list, a group, or not at all. */
export type ProjectAccessKind = "everywhere" | "own" | "group" | "none";

export interface ProjectAccessAssistantRow<A extends AccessAssistant> {
  readonly assistant: A;
  readonly kind: ProjectAccessKind;
  /** The groups that give it this project. */
  readonly viaTeams: ReadonlyArray<string>;
  /** Its conversation lives here, so its own access cannot be taken away from this screen. */
  readonly isHome: boolean;
}

/** Who can work in one project: each active group, and each active assistant. */
export function projectAccess<A extends AccessAssistant, T extends AccessTeam>(
  projectId: string,
  assistants: ReadonlyArray<A>,
  teams: ReadonlyArray<T>,
): {
  readonly groups: ReadonlyArray<{
    readonly team: T;
    readonly granted: boolean;
    /** Its active members; ids of archived or removed assistants are not counted. */
    readonly members: number;
    /** Active members that only work in listed projects: the ones a grant changes. */
    readonly gainingMembers: number;
  }>;
  readonly assistants: ReadonlyArray<ProjectAccessAssistantRow<A>>;
} {
  const active = assistants.filter((assistant) => assistant.archivedAt === null);
  return {
    groups: teams
      .filter((team) => team.archivedAt === null)
      .map((team) => ({
        team,
        granted: (team.projectIds as ReadonlyArray<string>).includes(projectId),
        members: active.filter((assistant) => team.memberIds.includes(assistant.id)).length,
        gainingMembers: membersGainingAccess(team, [projectId], active, teams),
      })),
    assistants: active.map((assistant) => {
      const viaTeams = (assistant.scope === "project" ? teams : [])
        .filter(
          (team) =>
            isActiveMember(team, assistant.id) &&
            (team.projectIds as ReadonlyArray<string>).includes(projectId),
        )
        .map((team) => team.name);
      const own = (assistant.projectIds as ReadonlyArray<string>).includes(projectId);
      return {
        assistant,
        viaTeams,
        isHome: assistant.scope === "project" && assistant.projectId === projectId,
        kind:
          assistant.scope !== "project"
            ? "everywhere"
            : own
              ? "own"
              : viaTeams.length > 0
                ? "group"
                : "none",
      };
    }),
  };
}

/**
 * The assistant's own list with `projectIds` added or taken out; null when that change is not
 * allowed: an assistant that works everywhere, or its home project, which holds its conversation.
 */
export function ownProjectsWith(
  assistant: AccessAssistant,
  projectIds: ReadonlyArray<ProjectId>,
  on: boolean,
): ReadonlyArray<ProjectId> | null {
  if (assistant.scope !== "project") return null;
  if (on) {
    const missing = projectIds.filter((id) => !assistant.projectIds.includes(id));
    return missing.length === 0 ? assistant.projectIds : [...assistant.projectIds, ...missing];
  }
  if (projectIds.includes(assistant.projectId)) return null;
  return assistant.projectIds.filter((id) => !projectIds.includes(id));
}

export interface AccessCheckout {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  /** The name the block title shows; environments on one host often share it. */
  readonly environmentLabel: string | null;
  readonly workspaceRoot: string;
}

/** What a block's title names; null when the project shows only one block. */
export interface ProjectAccessBlockTitle {
  /** The blocks span environments, so each names its own. */
  readonly environment: boolean;
  /** Another block shows the same environment name, so the checkout paths tell them apart. */
  readonly path: boolean;
  /** Another environment shows the same name and paths, so only its address tells them apart. */
  readonly address: boolean;
}

/**
 * One access block per set of checkouts that grant the same access. Access is stored per project
 * id, so checkouts of one project group can differ; only those in one environment can match.
 * Environments without assistants show no block. Blocks keep the order of their first checkout.
 */
export function projectAccessBlocks<
  C extends AccessCheckout,
  A extends AccessAssistant,
  T extends AccessTeam,
>(
  checkouts: ReadonlyArray<C>,
  assistants: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly assistant: A }>,
  teams: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly team: T }>,
): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly checkouts: ReadonlyArray<C>;
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly title: ProjectAccessBlockTitle | null;
}> {
  const blocks = new Map<
    string,
    { environmentId: EnvironmentId; environmentLabel: string | null; checkouts: Array<C> }
  >();
  for (const checkout of checkouts) {
    const access = projectAccess(
      checkout.id,
      assistants.flatMap((entry) =>
        entry.environmentId === checkout.environmentId ? [entry.assistant] : [],
      ),
      teams.flatMap((entry) =>
        entry.environmentId === checkout.environmentId ? [entry.team] : [],
      ),
    );
    if (access.groups.length === 0 && access.assistants.length === 0) continue;
    const key = JSON.stringify([
      checkout.environmentId,
      access.groups.map((row) => [row.team.id, row.granted]),
      access.assistants.map((row) => [row.assistant.id, row.kind, row.viaTeams, row.isHome]),
    ]);
    const block = blocks.get(key);
    if (block) block.checkouts.push(checkout);
    else
      blocks.set(key, {
        environmentId: checkout.environmentId,
        environmentLabel: checkout.environmentLabel,
        checkouts: [checkout],
      });
  }
  const list = [...blocks.values()].map((block) => ({
    ...block,
    paths: block.checkouts.map((checkout) => checkout.workspaceRoot).join("\n"),
  }));
  const environments = new Set(list.map((block) => block.environmentId));
  return list.map(({ environmentLabel, paths, ...block }) => {
    const sameName = list.filter(
      (other) =>
        other.checkouts !== block.checkouts &&
        (other.environmentId === block.environmentId ||
          other.environmentLabel === environmentLabel),
    );
    return {
      ...block,
      projectIds: block.checkouts.map((checkout) => checkout.id),
      title:
        list.length === 1
          ? null
          : {
              environment: environments.size > 1,
              path: sameName.length > 0,
              address: sameName.some(
                (other) => other.environmentId !== block.environmentId && other.paths === paths,
              ),
            },
    };
  });
}
