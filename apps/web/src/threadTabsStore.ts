import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * Thread tabs and tab groups for one project, after Orca's editor groups: each group is a tab
 * strip, the layout is a binary tree of groups, and a group left without tabs collapses. Tabs are
 * scoped thread keys. The routed thread is always the active tab of its group.
 */
export interface ThreadTabGroup {
  readonly id: string;
  readonly tabs: ReadonlyArray<string>;
  readonly active: string;
}

export type ThreadTabLayout =
  | { readonly type: "leaf"; readonly groupId: string }
  | {
      readonly type: "split";
      readonly id: string;
      readonly direction: "horizontal" | "vertical";
      /** Share of the first child. */
      readonly ratio: number;
      readonly first: ThreadTabLayout;
      readonly second: ThreadTabLayout;
    };

export interface ThreadTabWorkspace {
  readonly groups: ReadonlyArray<ThreadTabGroup>;
  readonly layout: ThreadTabLayout;
  /** The group a sidebar pick opens its thread in. */
  readonly focusedGroupId: string;
}

export type TabDropZone = "left" | "right" | "up" | "down" | "center";
export type TabDropTarget =
  | { readonly groupId: string; readonly zone: TabDropZone }
  | { readonly groupId: string; readonly index: number };

export const DEFAULT_SPLIT_RATIO = 0.5;
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;
/** The group a fresh workspace starts with, so its first render and commit agree. */
const FIRST_GROUP_ID = "main";

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function groupOfTab(
  workspace: ThreadTabWorkspace,
  tabKey: string,
): ThreadTabGroup | undefined {
  return workspace.groups.find((group) => group.tabs.includes(tabKey));
}

/** Leaves in reading order. */
function layoutGroupIds(layout: ThreadTabLayout): string[] {
  return layout.type === "leaf"
    ? [layout.groupId]
    : [...layoutGroupIds(layout.first), ...layoutGroupIds(layout.second)];
}

function removeLeaf(layout: ThreadTabLayout, groupId: string): ThreadTabLayout | null {
  if (layout.type === "leaf") return layout.groupId === groupId ? null : layout;
  const first = removeLeaf(layout.first, groupId);
  const second = removeLeaf(layout.second, groupId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}

function replaceLeaf(
  layout: ThreadTabLayout,
  groupId: string,
  next: ThreadTabLayout,
): ThreadTabLayout {
  if (layout.type === "leaf") return layout.groupId === groupId ? next : layout;
  return {
    ...layout,
    first: replaceLeaf(layout.first, groupId, next),
    second: replaceLeaf(layout.second, groupId, next),
  };
}

/** Drops empty groups and their leaves; focus falls back to the first group left. */
function collapse(workspace: ThreadTabWorkspace): ThreadTabWorkspace | null {
  const groups = workspace.groups.filter((group) => group.tabs.length > 0);
  let layout: ThreadTabLayout | null = workspace.layout;
  for (const group of workspace.groups) {
    if (group.tabs.length === 0 && layout) layout = removeLeaf(layout, group.id);
  }
  if (!layout || groups.length === 0) return null;
  const order = layoutGroupIds(layout);
  const focusedGroupId = order.includes(workspace.focusedGroupId)
    ? workspace.focusedGroupId
    : (order[0] ?? FIRST_GROUP_ID);
  return { groups, layout, focusedGroupId };
}

function withoutTab(group: ThreadTabGroup, tabKey: string): ThreadTabGroup {
  const index = group.tabs.indexOf(tabKey);
  if (index < 0) return group;
  const tabs = group.tabs.filter((tab) => tab !== tabKey);
  // The tab to the right takes over, like closing an editor tab; else the one to the left.
  const active =
    group.active === tabKey ? (tabs[Math.min(index, tabs.length - 1)] ?? "") : group.active;
  return { ...group, tabs, active };
}

/**
 * Commits a route change: a thread that is already a tab activates and focuses its group; any
 * other opens after the focused group's active tab.
 */
export function reconcileRouteTab(
  workspace: ThreadTabWorkspace | undefined,
  routeKey: string,
): ThreadTabWorkspace {
  if (!workspace) {
    return {
      groups: [{ id: FIRST_GROUP_ID, tabs: [routeKey], active: routeKey }],
      layout: { type: "leaf", groupId: FIRST_GROUP_ID },
      focusedGroupId: FIRST_GROUP_ID,
    };
  }
  const owner = groupOfTab(workspace, routeKey);
  if (owner) {
    if (owner.active === routeKey && workspace.focusedGroupId === owner.id) return workspace;
    return {
      ...workspace,
      focusedGroupId: owner.id,
      groups: workspace.groups.map((group) =>
        group.id === owner.id ? { ...group, active: routeKey } : group,
      ),
    };
  }
  const focused =
    workspace.groups.find((group) => group.id === workspace.focusedGroupId) ?? workspace.groups[0];
  if (!focused) return reconcileRouteTab(undefined, routeKey);
  return {
    ...workspace,
    focusedGroupId: focused.id,
    groups: workspace.groups.map((group) => {
      if (group.id !== focused.id) return group;
      const tabs = [...group.tabs];
      tabs.splice(tabs.indexOf(group.active) + 1, 0, routeKey);
      return { ...group, tabs, active: routeKey };
    }),
  };
}

/**
 * Moves `tabKey` (a tab, or a thread dragged in from outside) onto `target`: an index in a strip,
 * the center of a group, or one of its edges, which splits a new group off it. The tab becomes
 * active and its group focused. Null when the drop changes nothing.
 */
export function dropThreadTab(
  workspace: ThreadTabWorkspace,
  tabKey: string,
  target: TabDropTarget,
  newId: () => string,
): ThreadTabWorkspace | null {
  const targetGroup = workspace.groups.find((group) => group.id === target.groupId);
  if (!targetGroup) return null;
  const source = groupOfTab(workspace, tabKey);
  const zone = "zone" in target ? target.zone : null;

  if (zone !== null && zone !== "center") {
    // Splitting a group's only tab off itself would collapse straight back.
    if (source?.id === targetGroup.id && source.tabs.length === 1) return null;
    const groupId = newId();
    const before = zone === "left" || zone === "up";
    const leaf = { type: "leaf", groupId: targetGroup.id } as const;
    const added = { type: "leaf", groupId } as const;
    const split: ThreadTabLayout = {
      type: "split",
      id: newId(),
      direction: zone === "left" || zone === "right" ? "horizontal" : "vertical",
      ratio: DEFAULT_SPLIT_RATIO,
      first: before ? added : leaf,
      second: before ? leaf : added,
    };
    return collapse({
      layout: replaceLeaf(workspace.layout, targetGroup.id, split),
      focusedGroupId: groupId,
      groups: [
        ...workspace.groups.map((group) => withoutTab(group, tabKey)),
        { id: groupId, tabs: [tabKey], active: tabKey },
      ],
    });
  }

  const fromIndex = targetGroup.tabs.indexOf(tabKey);
  const remaining = targetGroup.tabs.filter((tab) => tab !== tabKey);
  const requested = "index" in target ? target.index : remaining.length;
  // An index counted with the dragged tab still in this strip shifts once it is lifted out.
  const index = Math.max(
    0,
    Math.min(remaining.length, fromIndex >= 0 && requested > fromIndex ? requested - 1 : requested),
  );
  const tabs = [...remaining.slice(0, index), tabKey, ...remaining.slice(index)];
  const unchanged =
    tabs.every((tab, position) => targetGroup.tabs[position] === tab) &&
    tabs.length === targetGroup.tabs.length &&
    targetGroup.active === tabKey &&
    workspace.focusedGroupId === targetGroup.id;
  if (unchanged) return null;
  return collapse({
    layout: workspace.layout,
    focusedGroupId: targetGroup.id,
    groups: workspace.groups.map((group) =>
      group.id === targetGroup.id ? { ...group, tabs, active: tabKey } : withoutTab(group, tabKey),
    ),
  });
}

/**
 * Closes a tab. Returns the thread to route to when the routed tab closed, or `null` for no
 * thread left; `undefined` leaves the route alone.
 */
export function closeThreadTab(
  workspace: ThreadTabWorkspace,
  tabKey: string,
  routeKey: string | null,
): {
  readonly workspace: ThreadTabWorkspace | null;
  readonly navigateTo: string | null | undefined;
} {
  const owner = groupOfTab(workspace, tabKey);
  if (!owner) return { workspace, navigateTo: undefined };
  const next = collapse({
    ...workspace,
    groups: workspace.groups.map((group) => withoutTab(group, tabKey)),
  });
  if (tabKey !== routeKey) return { workspace: next, navigateTo: undefined };
  if (next === null) return { workspace: null, navigateTo: null };
  // The closed group's neighbour takes over, or the focused group when the closed one went away.
  const heir =
    next.groups.find((group) => group.id === owner.id) ??
    next.groups.find((group) => group.id === next.focusedGroupId);
  const navigateTo = heir?.active ?? null;
  return {
    workspace: heir ? { ...next, focusedGroupId: heir.id } : next,
    navigateTo,
  };
}

export function focusThreadTabGroup(
  workspace: ThreadTabWorkspace,
  groupId: string,
): ThreadTabWorkspace {
  return workspace.focusedGroupId === groupId
    ? workspace
    : { ...workspace, focusedGroupId: groupId };
}

export function setThreadSplitRatio(
  workspace: ThreadTabWorkspace,
  splitId: string,
  ratio: number,
): ThreadTabWorkspace {
  const visit = (node: ThreadTabLayout): ThreadTabLayout =>
    node.type === "leaf"
      ? node
      : node.id === splitId
        ? { ...node, ratio: clampSplitRatio(ratio) }
        : { ...node, first: visit(node.first), second: visit(node.second) };
  return { ...workspace, layout: visit(workspace.layout) };
}

/** Joins every group into the focused one, in reading order. */
export function mergeThreadTabGroups(workspace: ThreadTabWorkspace): ThreadTabWorkspace {
  const focused = workspace.groups.find((group) => group.id === workspace.focusedGroupId);
  if (!focused || workspace.groups.length < 2) return workspace;
  const byId = new Map(workspace.groups.map((group) => [group.id, group]));
  const tabs = layoutGroupIds(workspace.layout).flatMap((id) => byId.get(id)?.tabs ?? []);
  return {
    groups: [{ ...focused, tabs }],
    layout: { type: "leaf", groupId: focused.id },
    focusedGroupId: focused.id,
  };
}

/** Orca's zones: the middle merges; near an edge, the outer thirds split sideways, else up or down. */
export function resolveTabDropZone(
  rect: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number },
): TabDropZone {
  const x = point.x - rect.left;
  const y = point.y - rect.top;
  const edgeX = rect.width * 0.1;
  const edgeY = rect.height * 0.1;
  if (x > edgeX && x < rect.width - edgeX && y > edgeY && y < rect.height - edgeY) return "center";
  if (x < rect.width / 3) return "left";
  if (x > (rect.width * 2) / 3) return "right";
  return y < rect.height / 2 ? "up" : "down";
}

/** Insertion index in a strip: before the first tab whose middle lies right of the pointer. */
export function resolveTabInsertIndex(
  tabs: ReadonlyArray<{ left: number; width: number }>,
  x: number,
): number {
  const index = tabs.findIndex((tab) => x < tab.left + tab.width / 2);
  return index < 0 ? tabs.length : index;
}

export interface LayoutRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Each group's share of the area, and each split's divider line, as fractions of 0..1. */
export function layoutGeometry(layout: ThreadTabLayout): {
  readonly groups: ReadonlyMap<string, LayoutRect>;
  readonly dividers: ReadonlyArray<{
    readonly split: Extract<ThreadTabLayout, { type: "split" }>;
    readonly rect: LayoutRect;
  }>;
} {
  const groups = new Map<string, LayoutRect>();
  const dividers: Array<{ split: Extract<ThreadTabLayout, { type: "split" }>; rect: LayoutRect }> =
    [];
  const visit = (node: ThreadTabLayout, rect: LayoutRect) => {
    if (node.type === "leaf") {
      groups.set(node.groupId, rect);
      return;
    }
    dividers.push({ split: node, rect });
    if (node.direction === "horizontal") {
      const first = rect.width * node.ratio;
      visit(node.first, { ...rect, width: first });
      visit(node.second, { ...rect, left: rect.left + first, width: rect.width - first });
    } else {
      const first = rect.height * node.ratio;
      visit(node.first, { ...rect, height: first });
      visit(node.second, { ...rect, top: rect.top + first, height: rect.height - first });
    }
  };
  visit(layout, { left: 0, top: 0, width: 1, height: 1 });
  return { groups, dividers };
}

export function parsePersistedWorkspace(value: unknown): ThreadTabWorkspace | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.groups)) return null;
  const groups = record.groups.flatMap((raw): ThreadTabGroup[] => {
    const group = raw as Record<string, unknown> | null;
    const tabs = Array.isArray(group?.tabs)
      ? [...new Set(group.tabs.filter((tab): tab is string => typeof tab === "string"))]
      : [];
    if (typeof group?.id !== "string" || tabs.length === 0) return [];
    const active =
      typeof group.active === "string" && tabs.includes(group.active) ? group.active : tabs[0]!;
    return [{ id: group.id, tabs, active }];
  });
  const ids = new Set(groups.map((group) => group.id));
  const readLayout = (raw: unknown): ThreadTabLayout | null => {
    const node = raw as Record<string, unknown> | null;
    if (node?.type === "leaf") {
      return typeof node.groupId === "string" && ids.has(node.groupId)
        ? { type: "leaf", groupId: node.groupId }
        : null;
    }
    if (node?.type !== "split" || typeof node.id !== "string") return null;
    const first = readLayout(node.first);
    const second = readLayout(node.second);
    if (!first || !second) return first ?? second;
    return {
      type: "split",
      id: node.id,
      direction: node.direction === "vertical" ? "vertical" : "horizontal",
      ratio: clampSplitRatio(typeof node.ratio === "number" ? node.ratio : DEFAULT_SPLIT_RATIO),
      first,
      second,
    };
  };
  const layout = readLayout(record.layout);
  if (!layout) return null;
  // A thread belongs to one group, and only groups the layout shows survive.
  const placed = new Set<string>();
  const shown = new Set(layoutGroupIds(layout));
  return collapse({
    layout,
    focusedGroupId: typeof record.focusedGroupId === "string" ? record.focusedGroupId : "",
    groups: groups
      .filter((group) => shown.has(group.id))
      .map((group) => {
        const tabs = group.tabs.filter((tab) => !placed.has(tab));
        for (const tab of tabs) placed.add(tab);
        return {
          ...group,
          tabs,
          active: tabs.includes(group.active) ? group.active : (tabs[0] ?? ""),
        };
      }),
  });
}

interface ThreadTabsState {
  /** By `environmentId:projectId`. */
  readonly byProject: Readonly<Record<string, ThreadTabWorkspace>>;
}

const THREAD_TABS_STORAGE_KEY = "t3code:thread-tabs:v1";

// One layout per project and browser profile, shared by its tabs and windows like the right panel.
export const useThreadTabsStore = create<ThreadTabsState>()(
  persist((): ThreadTabsState => ({ byProject: {} }), {
    name: THREAD_TABS_STORAGE_KEY,
    version: 1,
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    merge: (persisted, current) => {
      const raw = (persisted as { byProject?: unknown } | null)?.byProject;
      const byProject: Record<string, ThreadTabWorkspace> = {};
      if (typeof raw === "object" && raw !== null) {
        for (const [key, value] of Object.entries(raw)) {
          const workspace = parsePersistedWorkspace(value);
          if (workspace) byProject[key] = workspace;
        }
      }
      return { ...current, byProject };
    },
  }),
);

/** Applies `next` to one project's tabs; an unchanged result neither notifies nor writes storage. */
export function updateThreadTabs(
  projectKey: string,
  next: (workspace: ThreadTabWorkspace | undefined) => ThreadTabWorkspace | null | undefined,
): void {
  const { byProject } = useThreadTabsStore.getState();
  const current = byProject[projectKey];
  const result = next(current);
  if (result === current) return;
  const { [projectKey]: _replaced, ...rest } = byProject;
  useThreadTabsStore.setState({ byProject: result ? { ...rest, [projectKey]: result } : rest });
}

function newThreadTabId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** The workspace with the routed thread already opened in it. */
export function withRouteTab(
  workspace: ThreadTabWorkspace | undefined,
  routeKey: string,
): ThreadTabWorkspace {
  return workspace && groupOfTab(workspace, routeKey)
    ? workspace
    : reconcileRouteTab(workspace, routeKey);
}

/** Drops `threadKey` onto `target`; true when the layout changed. */
export function applyThreadTabDrop(
  projectKey: string,
  routeKey: string,
  threadKey: string,
  target: TabDropTarget | { readonly beside: true },
): boolean {
  let moved = false;
  updateThreadTabs(projectKey, (current) => {
    const base = withRouteTab(current, routeKey);
    const resolved =
      "beside" in target
        ? { groupId: groupOfTab(base, routeKey)?.id ?? FIRST_GROUP_ID, zone: "right" as const }
        : target;
    const next = dropThreadTab(base, threadKey, resolved, newThreadTabId);
    moved = next !== null;
    return next ?? current;
  });
  return moved;
}

export function joinThreadTabGroups(projectKey: string): void {
  updateThreadTabs(projectKey, (current) => current && mergeThreadTabGroups(current));
}
