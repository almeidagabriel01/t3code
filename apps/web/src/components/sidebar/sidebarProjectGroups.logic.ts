import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { SidebarListItem, SidebarListMarker, SidebarSection } from "../Sidebar.logic";

type ProjectBound = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };

export interface SidebarProjectThreadGroup<T> {
  readonly projectKey: string;
  /** Pinned first, then every other unsettled thread. */
  readonly openThreads: readonly T[];
  /** Most recent first, as the partition already sorts them. */
  readonly settledThreads: readonly T[];
}

export const PROJECT_SETTLED_INITIAL_COUNT = 5;
export const PROJECT_SETTLED_PAGE_COUNT = 10;

export function groupThreadsByProject<T extends ProjectBound>(input: {
  readonly groups: ReadonlyArray<{
    readonly projectKey: string;
    readonly memberProjects: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly id: ProjectId;
    }>;
  }>;
  readonly pinned: readonly T[];
  readonly unsettled: readonly T[];
  readonly settled: readonly T[];
}): SidebarProjectThreadGroup<T>[] {
  const projectKeyByMember = new Map<string, string>();
  for (const group of input.groups) {
    for (const member of group.memberProjects) {
      projectKeyByMember.set(
        scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
        group.projectKey,
      );
    }
  }
  const open = new Map<string, T[]>();
  const settled = new Map<string, T[]>();
  const place = (target: Map<string, T[]>, threads: readonly T[]) => {
    for (const thread of threads) {
      const projectKey = projectKeyByMember.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (projectKey === undefined) continue;
      const list = target.get(projectKey);
      if (list === undefined) target.set(projectKey, [thread]);
      else list.push(thread);
    }
  };
  place(open, input.pinned);
  place(open, input.unsettled);
  place(settled, input.settled);
  return input.groups.map((group) => ({
    projectKey: group.projectKey,
    openThreads: open.get(group.projectKey) ?? [],
    settledThreads: settled.get(group.projectKey) ?? [],
  }));
}

/**
 * What a project group renders, plus what stays reachable (keyboard, handlers) for the open
 * route thread. A settled thread only renders inside an expanded Settled group.
 */
export function resolveVisibleProjectThreads<T>(input: {
  readonly group: SidebarProjectThreadGroup<T>;
  readonly getKey: (thread: T) => string;
  readonly expanded: boolean;
  readonly settledExpanded: boolean;
  readonly settledLimit: number;
  readonly routeThreadKey: string | null;
}): {
  readonly open: readonly T[];
  readonly settled: readonly T[];
  readonly reachable: readonly T[];
} {
  const { group, getKey, routeThreadKey } = input;
  const routeOnly = (threads: readonly T[]) =>
    routeThreadKey === null ? [] : threads.filter((thread) => getKey(thread) === routeThreadKey);
  const settled = (() => {
    if (!input.expanded || !input.settledExpanded) return [];
    const head = group.settledThreads.slice(0, input.settledLimit);
    return routeThreadKey !== null && !head.some((thread) => getKey(thread) === routeThreadKey)
      ? [...head, ...routeOnly(group.settledThreads)]
      : head;
  })();
  const reachable =
    settled.length === 0 && routeThreadKey !== null ? routeOnly(group.settledThreads) : settled;
  return {
    open: input.expanded ? group.openThreads : routeOnly(group.openThreads),
    settled,
    reachable,
  };
}

const PROJECT_DRAG_PREFIX = "sidebar-project:";

export const projectDragId = (projectKey: string) => `${PROJECT_DRAG_PREFIX}${projectKey}`;
export const isProjectDragId = (id: string) => id.startsWith(PROJECT_DRAG_PREFIX);
export const projectKeyFromDragId = (id: string) => id.slice(PROJECT_DRAG_PREFIX.length);

/**
 * One expanded project's sortable list, in the layout `resolveSidebarDropTarget` reads: pinned,
 * the open list, then Settled. Markers carry the project scope so dnd ids stay unique.
 */
export function buildProjectListItems(input: {
  readonly scope: string;
  readonly open: ReadonlyArray<{ readonly key: string; readonly section: SidebarSection }>;
  readonly settledKeys: readonly string[];
}): SidebarListItem[] {
  const { scope } = input;
  const marker = (name: SidebarListMarker): SidebarListItem => ({
    kind: "marker",
    marker: name,
    scope,
  });
  const rows = (section: SidebarSection): SidebarListItem[] =>
    input.open
      .filter((thread) => thread.section === section)
      .map(({ key }) => ({ kind: "thread", key, section, scope }));
  const items: SidebarListItem[] = [
    marker("pinned-header"),
    ...rows("pinned"),
    marker("pinned-divider"),
    marker("active-placeholder"),
    ...rows("active"),
  ];
  for (const [section, header] of [
    ["working", "working-header"],
    ["snoozed", "snoozed-header"],
  ] as const) {
    const sectionRows = rows(section);
    if (sectionRows.length > 0) items.push(marker(header), ...sectionRows);
  }
  items.push(
    marker("settled-header"),
    marker("settled-placeholder"),
    ...input.settledKeys.map((key): SidebarListItem => ({
      kind: "thread",
      key,
      section: "settled",
      scope,
    })),
  );
  return items;
}

/** Splits a flat scoped list back into each project's own list. */
export function groupListItemsByScope(
  items: readonly SidebarListItem[],
): ReadonlyMap<string, readonly SidebarListItem[]> {
  const byScope = new Map<string, SidebarListItem[]>();
  for (const item of items) {
    if (item.scope === undefined) continue;
    const list = byScope.get(item.scope);
    if (list === undefined) byScope.set(item.scope, [item]);
    else list.push(item);
  }
  return byScope;
}
