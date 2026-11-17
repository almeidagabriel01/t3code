import { RegistryProvider } from "@effect/atom-react";
import { act, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Mood = "idle" | "working" | "needs" | "limited" | "failed";
type Presence = {
  mood: Mood;
  detail: string;
  since: string | null;
  queued?: number;
  resetAt?: string;
};

const { mocks } = vi.hoisted(() => ({
  mocks: {
    open: vi.fn(),
    editor: vi.fn(),
    work: vi.fn(),
    info: { assistant: vi.fn(), group: vi.fn() },
    toggle: vi.fn(),
    openTeam: vi.fn(),
    chat: vi.fn(),
    archiveTeam: vi.fn(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
    navigate: vi.fn(),
    reset: vi.fn(),
    archive: vi.fn(),
    version: 0,
    listeners: new Set<() => void>(),
    workRenders: 0,
    teamRenders: 0,
    running: new Set<string>(),
    expandedGroups: [] as string[],
    toggleGroup: vi.fn(),
    pending: {} as Record<string, { id: string; kind: string; createdAt: string }>,
    extraTasks: new Map<
      string,
      Array<{ threadId: string; title: string; createdAt: string; dismissedAt?: string | null }>
    >(),
    teams: [] as Array<{
      environmentId: string;
      team: {
        id: string;
        name: string;
        memberIds: string[];
        chat?: {
          unreadCount: number;
          latestSeq: number;
          pausedTasks?: number;
          failedTasks?: number;
          threadIds?: string[];
        };
      };
    }>,
    collapsed: false,
    showAll: false,
    rowWidth: undefined as number | undefined,
    metaWidth: undefined as number | undefined,
    tasks: [] as Array<{
      threadId: string;
      title: string;
      createdAt: string;
      dismissedAt?: string | null;
    }>,
    dismissTask: vi.fn(),
    drafts: new Set<string>(),
    clearDraft: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    liveWork: {
      sites: [] as Array<Record<string, string>>,
      subagents: new Map<
        string,
        Array<{
          id: string;
          title: string;
          environmentId?: string;
          pinnedAt?: string | null;
          runtime?: null;
        }>
      >(),
    },
    toggleShowAll: vi.fn(),
    toggleFold: vi.fn(),
    folded: new Set<string>(),
    settled: new Set<string>(),
    snoozed: new Set<string>(),
    presence: {} as Record<string, Presence>,
    notified: new Set<string>(),
    projects: [] as Array<{ environmentId: string; id: string; title: string }>,
    active: [] as Array<{
      environmentId: string;
      assistant: {
        id: string;
        name: string;
        handle: string;
        threadId: string | null;
        role: string;
        scope: string;
        projectId: string;
      };
    }>,
  },
}));
const { helpers } = vi.hoisted(() => {
  const reactHooks = { useSyncExternalStore: undefined as unknown as typeof useSyncExternalStore };
  const shellBase = (id: string) => ({
    archivedAt: null,
    lineage: { parentThreadId: null },
    delegatedFrom: null,
    pendingRequest: mocks.pending[id] ?? null,
  });
  const shellCache = new Map<string, { signature: string; shell: { id: string } }>();
  const quietShells = () => {
    // Re-rendered on every pushed update, as the quiet shell list is.
    reactHooks.useSyncExternalStore(
      (listener) => {
        mocks.listeners.add(listener);
        return () => mocks.listeners.delete(listener);
      },
      () => mocks.version,
    );
    const built = [
      ...mocks.active.flatMap((entry) =>
        entry.assistant.threadId === null
          ? []
          : [
              {
                ...shellBase(entry.assistant.threadId),
                environmentId: entry.environmentId,
                id: entry.assistant.threadId,
              },
            ],
      ),
      ...[...mocks.liveWork.subagents.values()].flat().map((child) => ({
        ...shellBase(child.id),
        ...child,
      })),
      ...[...mocks.tasks, ...[...mocks.extraTasks.values()].flat()].map((task) => {
        const mood = mocks.presence[task.threadId]?.mood;
        return {
          ...shellBase(task.threadId),
          environmentId: "hub",
          id: task.threadId,
          title: task.title,
          settledOverride: mocks.settled.has(task.threadId) ? "settled" : null,
          settledAt: null,
          snoozedUntil: mocks.snoozed.has(task.threadId) ? "2026-12-01T00:00:00.000Z" : null,
          updatedAt: task.createdAt,
          runtime:
            mood === "working"
              ? { status: "running" }
              : mood === "failed"
                ? { status: "failed" }
                : mood === "limited"
                  ? {
                      status: "failed",
                      lastErrorClass: "usage_limit",
                      usageLimitResetAt: mocks.presence[task.threadId]?.resetAt,
                    }
                  : null,
        };
      }),
    ];
    // A shell keeps its identity until it changes; running tasks change on every pushed update.
    return built.map((shell) => {
      const signature = `${JSON.stringify(shell)}:${mocks.running.has(shell.id) ? mocks.version : 0}`;
      const cached = shellCache.get(shell.id);
      if (cached?.signature === signature) return cached.shell;
      shellCache.set(shell.id, { signature, shell });
      return shell;
    });
  };

  const tasksByAssistant = () => new Map([["hub:a0", mocks.tasks], ...mocks.extraTasks]);
  return { helpers: { quietShells, tasksByAssistant, reactHooks } };
});
helpers.reactHooks.useSyncExternalStore = useSyncExternalStore;
vi.mock("react-native", () => ({
  View: (props: {
    children?: ReactNode;
    testID?: string;
    className?: string;
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
  }) => (
    <div
      data-testid={props.testID}
      className={props.className}
      ref={(node) => {
        if (node && props.onLayout && mocks.metaWidth !== undefined)
          props.onLayout({ nativeEvent: { layout: { width: mocks.metaWidth } } });
      }}
    >
      {props.children}
    </div>
  ),
  Pressable: (props: {
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
    disabled?: boolean;
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
    children?: ReactNode;
  }) => (
    <button
      ref={(node) => {
        if (node && mocks.rowWidth !== undefined)
          props.onLayout?.({ nativeEvent: { layout: { width: mocks.rowWidth } } });
      }}
      aria-label={props.accessibilityLabel}
      aria-expanded={props.accessibilityState?.expanded}
      disabled={props.disabled}
      onClick={(event) => {
        // A nested Pressable takes the press alone, as on device.
        event.stopPropagation();
        props.onPress?.();
      }}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
  scopedThreadKey: (ref: { environmentId: string; threadId: string }) =>
    `${ref.environmentId}:${ref.threadId}`,
}));
vi.mock("@t3tools/client-runtime/assistantRobot", () => ({
  assistantGroupThreadsOf: () => [],
  assistantGroupOwnerKey: () => undefined,
  assistantFace: (presence: { mood: string }) =>
    presence.mood === "needs" ? "waiting" : presence.mood,
  assistantQueuedLabel: (queued: number | undefined) =>
    queued !== undefined && queued > 0 ? `${queued} queued` : null,
  assistantPresence: (
    thread: { id: string } | null,
    _groups: unknown,
    limitLabel?: (resetAt: string | undefined) => string | null,
  ): Presence => {
    const presence =
      thread === null
        ? { mood: "idle" as const, detail: "Idle", since: null }
        : (mocks.presence[thread.id] ?? { mood: "idle" as const, detail: "Idle", since: null });
    return presence.mood === "limited"
      ? { ...presence, detail: limitLabel?.(presence.resetAt) ?? "Usage limit" }
      : presence;
  },
}));
vi.mock("@t3tools/client-runtime/state/thread-attention", () => ({
  resolveSidebarThreadStatus: (thread: { id: string }) =>
    mocks.presence[thread.id]?.mood === "working" ? "working" : "ready",
  hasSidebarNotification: (thread: { id: string }) => mocks.notified.has(thread.id),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <b>spinner</b>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode; className?: string; testID?: string }) => (
    <span className={props.className} data-testid={props.testID}>
      {props.children}
    </span>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: (props: { name: string }) => <s>{`symbol:${props.name}`}</s>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: Array<{ id: string; title: string; attributes?: { disabled?: boolean } }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          aria-label={`menu:${action.title}`}
          disabled={action.attributes?.disabled}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </>
  ),
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => Date.parse("2026-11-06T12:00:00Z") }));
vi.mock("../../state/entities", () => ({
  useQuietThreadShells: helpers.quietShells,
  useProjects: () => [{ id: "p1", environmentId: "hub", title: "t3code" }],
}));
vi.mock("../../state/assistants", async () => {
  const { buildThreadOwnership } = await import("../../state/threadOwnership");
  const { assistantStatusOf } = await import("@t3tools/client-runtime/sidebarZones");
  const ownership = () =>
    buildThreadOwnership({
      shells: helpers.quietShells() as never,
      active: mocks.active,
      activeTeams: mocks.teams.map((entry) => ({
        environmentId: entry.environmentId,
        team: { id: entry.team.id, chat: { threadIds: entry.team.chat?.threadIds ?? [] } },
      })),
      tasksByAssistant: helpers.tasksByAssistant(),
    });
  return {
    useAssistantEntries: () => ({ active: mocks.active, activeTeams: mocks.teams }),
    useAssistantLiveWork: () => mocks.liveWork,
    useAssistantTasksByAssistant: helpers.tasksByAssistant,
    useThreadOwnership: ownership,
    useAssistantStatus: () =>
      assistantStatusOf({
        shells: helpers.quietShells() as never,
        decisions: [],
        ownerOf: ownership().ownerOf,
        sites: (mocks.liveWork?.sites ?? []) as never,
        reachable: () => null,
      }),
  };
});
vi.mock("../../state/decisions", () => ({ useDecisionEntries: () => ({ open: [] }) }));
vi.mock("../../state/use-composer-drafts", () => ({
  useHasUnsentDraft: (key: string | null) => key !== null && mocks.drafts.has(key),
  clearComposerDraftContent: mocks.clearDraft,
}));
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { threadListEnvironmentsAtom: Atom.make({ pinningEnvironmentIds: new Set(["hub"]) }) };
});
vi.mock("../home/useThreadListActions", () => ({
  useThreadListActions: () => ({ pinThread: mocks.pin, unpinThread: mocks.unpin }),
}));
vi.mock("../threads/threadListV2", () => ({
  sortActiveThreadsForRows: (threads: ReadonlyArray<unknown>) => [...threads],
  buildThreadListV2ListItems: (input: {
    items: ReadonlyArray<{ thread: { environmentId: string; id: string } }>;
  }) =>
    input.items.map((item) => ({
      type: "v2-thread",
      key: `v2-thread:${item.thread.environmentId}:${item.thread.id}`,
      item,
    })),
}));
vi.mock("../threads/use-thread-list-v2-shelf-preferences", () => ({
  useThreadListV2ShelfPreferences: () => ({ threadOrder: "activity" }),
}));
vi.mock("../threads/thread-list-v2-items", () => ({
  ThreadListV2SettledShelfHeader: (props: {
    count: number;
    expanded: boolean;
    onToggle: () => void;
  }) => (
    <button
      aria-label={`settled:${props.count}`}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
    />
  ),
  ThreadListV2SnoozedShelfHeader: (props: {
    count: number;
    expanded: boolean;
    onToggle: () => void;
  }) => (
    <button
      aria-label={`snoozed:${props.count}`}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
    />
  ),
  ThreadListV2SubagentRow: (props: {
    thread: { id: string; title: string; pinnedAt?: string | null };
    pane: string;
    onSelectThread: (thread: { id: string }) => void;
    menu: {
      pinningSupported: boolean;
      onSetPinned: (thread: { id: string }, pinned: boolean) => void;
    };
  }) => (
    <>
      <button
        aria-label={`subagent:${props.thread.title}:${props.pane}`}
        onClick={() => props.onSelectThread(props.thread)}
      />
      {props.menu.pinningSupported ? (
        <button
          aria-label={`pin:${props.thread.title}`}
          onClick={() => props.menu.onSetPinned(props.thread, props.thread.pinnedAt == null)}
        />
      ) : null}
    </>
  ),
}));
vi.mock("../../components/ProjectFavicon", () => ({
  ProjectFavicon: (props: { projectTitle: string }) => <em>{`fav:${props.projectTitle}`}</em>,
}));
vi.mock("../threads/SubagentStatusDot", () => ({
  SubagentStatusDot: (props: { tone: string }) => <u>{`dot:${props.tone}`}</u>,
}));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { assistant: { name: string }; mood?: string }) => (
    <i>{`av:${props.assistant.name}:${props.mood ?? "-"}`}</i>
  ),
  AssistantCluster: (props: { faces: ReadonlyArray<unknown> }) => (
    <i data-testid="assistant-cluster" data-faces={props.faces.length} />
  ),
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({
    canAct: true,
    openConversation: mocks.open,
    reset: mocks.reset,
    archive: mocks.archive,
    dismissTask: mocks.dismissTask,
  }),
  // Only a folder row asks for this, so its calls count folder renders.
  useAssistantTeamFlows: () => {
    mocks.teamRenders += 1;
    return {
      canAct: true,
      canMarkRead: true,
      archive: mocks.archiveTeam,
      markRead: mocks.markRead,
      markUnread: mocks.markUnread,
    };
  },
}));
vi.mock("./assistantTeamTarget", () => ({
  useOpenAssistantTeam: () => ({ edit: mocks.openTeam, chat: mocks.chat }),
}));
vi.mock("./useUsageLimitLabel", () => ({
  useUsageLimitLabel: () => (resetAt: string | null | undefined) =>
    resetAt == null ? null : `Limit until <${resetAt}>`,
}));
vi.mock("./openAssistantEditor", () => ({ useOpenAssistantEditor: () => mocks.editor }));
vi.mock("./openAssistantInfo", () => ({ useOpenAssistantInfo: () => mocks.info }));
vi.mock("./assistantWorkTarget", () => ({
  // Only an assistant's own row asks for this, so its calls count that row's renders.
  useOpenAssistantWork: () => {
    mocks.workRenders += 1;
    return mocks.work;
  },
}));
vi.mock("../home/useHomeSectionPreferences", () => ({
  useHomeSectionPreferences: () => ({
    assistantsCollapsed: mocks.collapsed,
    toggleAssistants: mocks.toggle,
    assistantsShowAll: mocks.showAll,
    toggleAssistantsShowAll: mocks.toggleShowAll,
    assistantsFolded: mocks.folded,
    toggleAssistantFolded: mocks.toggleFold,
    assistantsExpandedGroups: mocks.expandedGroups,
    toggleAssistantsGroup: mocks.toggleGroup,
  }),
}));

import { HomeAssistantsSection, useAssistantSectionJumpThreads } from "./HomeAssistantsSection";

const bot = (i: number, extra: object = {}) => ({
  environmentId: "hub",
  assistant: {
    id: `a${i}`,
    name: `Bot${i}`,
    handle: `bot${i}`,
    threadId: `t${i}`,
    role: "",
    scope: "all",
    projectId: "p0",
    ...extra,
  },
});
const make = (n: number) => Array.from({ length: n }, (_, i) => bot(i));
const team = (
  id: string,
  name: string,
  memberIds: string[],
  environmentId = "hub",
  chat?: {
    unreadCount: number;
    latestSeq: number;
    pausedTasks?: number;
    failedTasks?: number;
    scopes?: unknown;
  },
) => ({
  environmentId,
  team: { id, name, memberIds, projectIds: ["p1"], ...(chat === undefined ? {} : { chat }) },
});

let root: Root;
let container: HTMLDivElement;
function JumpProbe(props: { drawn: boolean }) {
  const threads = useAssistantSectionJumpThreads(props.drawn);
  return <output data-testid="jump">{threads.map((thread) => thread.id).join(",")}</output>;
}
type HostItem = {
  item: { thread: { id: string }; variant: string; snoozed: boolean; pinned: boolean };
  compact?: boolean;
};
const hostRow = (item: HostItem) => (
  <i data-testid="host-row">
    {`${item.item.thread.id}:${item.item.variant}${item.item.snoozed ? ":snoozed" : ""}:${item.compact ? "compact" : "full"}`}
  </i>
);
const render = (
  sidebar = true,
  labels = new Map<string, string>(),
  extra: { renderThread?: unknown; drawn?: boolean; openConversationKey?: string } = {},
) =>
  act(() =>
    root.render(
      // A fresh registry per test: open groups and shelves live in a session atom.
      <RegistryProvider>
        <HomeAssistantsSection
          gutter={4}
          sidebar={sidebar}
          environmentById={
            new Map([...labels].map(([id, label]) => [id, { label, address: id }] as const))
          }
          {...(extra.renderThread ? { renderThread: extra.renderThread as never } : {})}
          {...(extra.openConversationKey ? { openConversationKey: extra.openConversationKey } : {})}
        />
        {extra.drawn === undefined ? null : <JumpProbe drawn={extra.drawn} />}
      </RegistryProvider>,
    ),
  );
const hostRows = () =>
  [...container.querySelectorAll('[data-testid="host-row"]')].map((row) => row.textContent);
const jump = () => container.querySelector('[data-testid="jump"]')?.textContent;
const byLabel = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const click = (label: string) => act(async () => byLabel(label)?.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  Object.assign(mocks, {
    collapsed: false,
    showAll: false,
    rowWidth: undefined,
    metaWidth: undefined,
    presence: {},
    notified: new Set(),
    active: make(2),
    teams: [],
    tasks: [],
    extraTasks: new Map(),
    pending: {},
    expandedGroups: [],
    version: 0,
    workRenders: 0,
    teamRenders: 0,
    running: new Set(),
    drafts: new Set(),
    liveWork: { sites: [], subagents: new Map() },
    folded: new Set(),
    settled: new Set(),
    snoozed: new Set(),
    projects: [{ environmentId: "hub", id: "p1", title: "Website" }],
  });
  for (const fn of [
    mocks.open,
    mocks.dismissTask,
    mocks.toggle,
    mocks.editor,
    mocks.work,
    mocks.openTeam,
    mocks.navigate,
    mocks.reset,
    mocks.archive,
    mocks.markRead,
    mocks.markUnread,
    mocks.toggleShowAll,
    mocks.toggleFold,
    mocks.toggleGroup,
    mocks.pin,
    mocks.unpin,
    mocks.clearDraft,
    mocks.info.assistant,
    mocks.info.group,
  ]) {
    fn.mockReset();
  }
});
afterEach(() => act(() => root.unmount()));

const assistantRows = () =>
  [...container.querySelectorAll('[aria-label^="Bot"]')]
    .map((row) => row.getAttribute("aria-label")!)
    .filter((label) => !/ (actions|tasks)$/.test(label));
const indicators = () =>
  [...container.querySelectorAll('[data-testid="zone-indicator"]')].map(
    (node) => node.getAttribute("aria-label") ?? node.textContent,
  );
const pushShellUpdate = () =>
  act(() => {
    mocks.version += 1;
    for (const listener of mocks.listeners) listener();
  });

describe("HomeAssistantsSection", () => {
  it("draws no work-site icons, lists live subagents and opens each", async () => {
    mocks.active = [bot(0, { scope: "project", projectId: "p1" })];
    mocks.liveWork = {
      sites: [{ environmentId: "hub", assistantId: "a0", projectId: "p1", threadId: "x" }],
      subagents: new Map([["hub:a0", [{ id: "child-1", title: "Review the diff" }]]]),
    };
    render();
    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelector('[data-testid="assistant-project"]')).toBeNull();
    await click("subagent:Review the diff:sidebar");
    expect(mocks.open).toHaveBeenLastCalledWith({ threadId: "child-1" });
  });

  it("folds settled tasks into the Settled shelf and folds the whole list", async () => {
    mocks.active = [bot(0)];
    mocks.presence["task-1"] = { mood: "working", detail: "Working", since: null };
    mocks.tasks = [
      { threadId: "task-1", title: "Add retry", createdAt: "2026-11-02T00:00:00.000Z" },
      { threadId: "task-2", title: "Old chore", createdAt: "2026-11-01T00:00:00.000Z" },
      { threadId: "task-3", title: "Older chore", createdAt: "2026-10-01T00:00:00.000Z" },
    ];
    mocks.settled = new Set(["task-2", "task-3"]);
    render();
    const titles = () =>
      [...container.querySelectorAll('[aria-label$=", Running"], [aria-label$=", Done"]')].map(
        (row) => row.getAttribute("aria-label"),
      );
    expect(titles()).toEqual(["Add retry, Running"]);
    await click("settled:2");
    expect(titles()).toEqual(["Add retry, Running", "Old chore, Done", "Older chore, Done"]);
    await click("Hide Bot0 tasks");
    expect(mocks.toggleFold).toHaveBeenCalledWith("hub:a0");
    mocks.folded = new Set(["hub:a0"]);
    render();
    expect(titles()).toEqual([]);
    expect(byLabel("Show Bot0 tasks")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("draws tasks with the host list's row, lighter, and keeps open shelves for the session", async () => {
    mocks.active = [bot(0)];
    mocks.tasks = [
      { threadId: "w1", title: "Add retry", createdAt: "2026-11-02T00:00:00.000Z" },
      { threadId: "w2", title: "Old chore", createdAt: "2026-11-01T00:00:00.000Z" },
      { threadId: "w3", title: "Later", createdAt: "2026-11-01T00:00:00.000Z" },
    ];
    mocks.settled = new Set(["w2"]);
    mocks.snoozed = new Set(["w3"]);
    const renderThread = vi.fn(hostRow);
    await render(true, new Map(), { renderThread: renderThread as never });
    expect(hostRows()).toEqual(["w1:card:compact"]);
    // The compact face rows are the Settings fallback only.
    expect(container.querySelector('[aria-label="Add retry, Running"]')).toBeNull();
    await click("snoozed:1");
    await click("settled:1");
    expect(hostRows()).toEqual(["w1:card:compact", "w3:slim:snoozed:compact", "w2:slim:compact"]);
    await render(true, new Map(), { renderThread: renderThread as never });
    expect(hostRows()).toHaveLength(3);
    await click("settled:1");
    expect(hostRows()).toEqual(["w1:card:compact", "w3:slim:snoozed:compact"]);
  });

  it("lists pinned subagents first and pins or unpins one from its menu", async () => {
    mocks.active = [bot(0)];
    mocks.liveWork = {
      sites: [],
      subagents: new Map([
        [
          "hub:a0",
          [
            { id: "c1", title: "Loose", environmentId: "hub", pinnedAt: null },
            // Finished, but pinned: it stays under its assistant until unpinned.
            {
              id: "c2",
              title: "Kept",
              environmentId: "hub",
              pinnedAt: "2026-11-01T00:00:00.000Z",
              runtime: null,
            },
          ],
        ],
      ]),
    };
    await render();
    const order = [...container.querySelectorAll('[aria-label^="subagent:"]')].map((row) =>
      row.getAttribute("aria-label"),
    );
    expect(order).toEqual(["subagent:Kept:sidebar", "subagent:Loose:sidebar"]);
    await click("pin:Loose");
    expect(mocks.pin).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    await click("pin:Kept");
    expect(mocks.unpin).toHaveBeenCalledWith(expect.objectContaining({ id: "c2" }));
  });

  it("numbers for ⌘1–9 exactly the rows the zone draws: ungrouped first, then open folders", async () => {
    mocks.active = make(2);
    mocks.tasks = [
      { threadId: "w1", title: "Add retry", createdAt: "2026-11-02T00:00:00.000Z" },
      { threadId: "w2", title: "Old chore", createdAt: "2026-11-01T00:00:00.000Z" },
    ];
    mocks.settled = new Set(["w2"]);
    mocks.teams = [team("g1", "Finance", ["a1"])];
    mocks.liveWork = {
      sites: [],
      subagents: new Map([["hub:a1", [{ id: "c1", title: "Child", environmentId: "hub" }]]]),
    };
    await render(true, new Map(), { drawn: true });
    expect(jump()).toBe("t0,w1");
    await click("settled:1");
    expect(jump()).toBe("t0,w1,w2");
    mocks.expandedGroups = ["group:hub:g1"];
    await render(true, new Map(), { drawn: true });
    expect(jump()).toBe("t0,w1,w2,t1,c1");
    mocks.folded = new Set(["hub:a0"]);
    await render(true, new Map(), { drawn: true });
    expect(jump()).toBe("t0,t1,c1");
    mocks.collapsed = true;
    await render(true, new Map(), { drawn: true });
    expect(jump()).toBe("");
    mocks.collapsed = false;
    await render(true, new Map(), { drawn: false });
    expect(jump()).toBe("");
  });

  it("draws an assistant in two groups once, in the first, and its task once; ungrouped come first", async () => {
    mocks.active = make(3);
    mocks.tasks = [{ threadId: "w1", title: "Add retry", createdAt: "2026-11-02T00:00:00.000Z" }];
    mocks.teams = [team("g1", "Finance", ["a0", "a1"]), team("g2", "Ops", ["a0"])];
    mocks.expandedGroups = ["group:hub:g1", "group:hub:g2"];
    const renderThread = vi.fn(hostRow);
    await render(true, new Map(), { renderThread: renderThread as never });
    expect(assistantRows()).toEqual(["Bot2", "Bot0", "Bot1"]);
    expect(hostRows()).toEqual(["w1:card:compact"]);
    const text = container.textContent ?? "";
    expect(text.indexOf("Bot2")).toBeLessThan(text.indexOf("Finance"));
    expect(text.indexOf("Finance")).toBeLessThan(text.indexOf("Bot0"));
    // Ops lists only a0, already drawn in Finance: it is empty here and has no chevron.
    expect(byLabel("Show Ops members")).toBeNull();
    expect(byLabel("Hide Ops members")).toBeNull();
    expect(container.querySelector('[data-testid="group-status"]')).not.toBeNull();
    expect(byLabel("Ops, No members yet")).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="group-mark"]')).toHaveLength(1);
    const caption = () => container.querySelector('[data-testid="group-empty-caption"]');
    expect(caption()?.textContent).toBe("No members yet");
    // A narrow row keeps the words for the screen reader only.
    mocks.metaWidth = 300;
    act(() => root.unmount());
    root = createRoot(container);
    await render(true, new Map(), { renderThread: renderThread as never });
    expect(caption()).toBeNull();
    expect(byLabel("Ops, No members yet")).not.toBeNull();
  });

  it.each([
    ["needs you", { pending: true, failed: 1, paused: 2, running: true, unread: 3 }, "Needs you"],
    ["running", { pending: false, failed: 1, paused: 2, running: true, unread: 3 }, "1 running"],
    ["failed", { pending: false, failed: 1, paused: 2, running: false, unread: 3 }, "Failed"],
    ["paused", { pending: false, failed: 0, paused: 2, running: false, unread: 3 }, "2 paused"],
    ["unread", { pending: false, failed: 0, paused: 0, running: false, unread: 3 }, "3 unread"],
  ] as const)("a folder shows one indicator, %s first", (_name, state, label) => {
    mocks.active = [bot(0, { threadId: "assistant:a0:1" }), bot(1)];
    mocks.teams = [
      team("g1", "Finance", ["a0", "a1"], "hub", {
        unreadCount: state.unread,
        latestSeq: 9,
        pausedTasks: state.paused,
        failedTasks: state.failed,
      }),
    ];
    if (state.running) mocks.presence.t1 = { mood: "working", detail: "W", since: null };
    if (state.pending)
      mocks.pending["assistant:a0:1"] = {
        id: "r1",
        kind: "command",
        createdAt: "2026-11-01T00:00:00.000Z",
      };
    render();
    expect(indicators()).toEqual([label]);
    expect(container.textContent).not.toContain("spinner");
  });

  it("a folder's indicator says where it comes from and opens the request that waits", async () => {
    mocks.active = [bot(0, { threadId: "assistant:a0:1" }), bot(1)];
    const waiting = {
      projectId: "p1",
      unreadCount: 0,
      waiting: true,
      readSeq: 0,
      waitingRequest: { requestId: "m7", title: "Fix", reason: "paused", assistantId: null },
    };
    mocks.teams = [
      team("g1", "Finance", ["a0", "a1"], "hub", {
        unreadCount: 0,
        latestSeq: 9,
        scopes: [waiting],
      }),
    ];
    mocks.pending["assistant:a0:1"] = {
      id: "r1",
      kind: "command",
      createdAt: "2026-11-01T00:00:00.000Z",
    };
    render();
    const detail = "Needs you · t3code: Fix (Paused)";
    expect(container.querySelector(`[aria-label="menu:${detail}"]`)).not.toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[aria-label="Needs you. ${detail}"]`)!.click(),
    );
    expect(mocks.chat).toHaveBeenCalledWith("hub", "g1", { tab: "project:p1", requestId: "m7" });
  });

  it("marks an assistant's and a group's row while it holds a draft, and discards it from the menu", async () => {
    mocks.active = [bot(0), bot(1), bot(2)];
    mocks.teams = [team("g1", "Finance", ["a2"])];
    // The assistant's conversation and the group's chat, a reply to a request included, share
    // the draft keys their composers write.
    mocks.drafts = new Set(["hub:t0", "hub:assistant-group:g1"]);
    render(false);
    expect(assistantRows()).toEqual(["Bot0, Draft", "Bot1"]);
    expect(byLabel("Finance, Draft")).not.toBeNull();
    const marks = () =>
      [...container.querySelectorAll('[data-testid="draft-mark"]')].map((mark) => mark.textContent);
    expect(marks()).toEqual(["symbol:square.and.pencilDraft", "symbol:square.and.pencilDraft"]);
    const discards = [...container.querySelectorAll('[aria-label="menu:Discard draft"]')];
    // The row's long-press menu and its ⋯ button for Bot0, the ⋯ button for the group.
    expect(discards).toHaveLength(3);
    await act(async () => discards.forEach((button) => (button as HTMLButtonElement).click()));
    expect(mocks.clearDraft.mock.calls).toEqual([
      ["hub:t0"],
      ["hub:t0"],
      ["hub:assistant-group:g1"],
    ]);
    // The conversation on screen beside the list never marks its own draft.
    for (const openConversationKey of ["hub:t0", "hub:assistant-group:g1"]) {
      act(() => root.unmount());
      root = createRoot(container);
      render(true, new Map(), { openConversationKey });
      expect(marks()).toHaveLength(1);
      expect(
        byLabel(openConversationKey === "hub:t0" ? "Bot0" : "Finance"),
        openConversationKey,
      ).not.toBeNull();
    }
    // Narrow rows keep the pen and drop the word.
    Object.assign(mocks, { rowWidth: 200, metaWidth: 200 });
    act(() => root.unmount());
    root = createRoot(container);
    render(false);
    expect(marks()).toEqual(["symbol:square.and.pencil", "symbol:square.and.pencil"]);
  });

  it("an assistant row shows its full name, the role muted, and one static indicator", () => {
    mocks.active = [
      bot(0, { role: "CEO", threadId: "assistant:a0:1" }),
      bot(1),
      bot(2, { role: "Ops" }),
    ];
    mocks.presence.t1 = { mood: "working", detail: "Reading the repo", since: null };
    mocks.presence["assistant:a0:1"] = { mood: "needs", detail: "Needs you", since: null };
    mocks.pending["assistant:a0:1"] = {
      id: "r1",
      kind: "user_input",
      createdAt: "2026-11-01T00:00:00.000Z",
    };
    // A "needs" presence the Needs you list does not hold (T3 answers it itself) reads as work.
    mocks.presence.t2 = { mood: "needs", detail: "Needs you", since: null };
    render(false);
    expect(assistantRows()).toEqual([
      "Bot0, CEO, Needs you",
      "Bot1, Working",
      "Bot2, Ops, Working",
    ]);
    expect(indicators()).toEqual(["Needs you", "Working", "Working"]);
    expect(container.textContent).toContain("CEO");
    expect(container.textContent).not.toContain("spinner");
    // Too narrow for the role: the name stays, the role leaves.
    mocks.rowWidth = 200;
    act(() => root.unmount());
    root = createRoot(container);
    render(false);
    expect(container.textContent).not.toContain("CEO");
    expect(container.textContent).toContain("Bot0");
    // Wide enough for the role, but an indicator leaves only a sliver: no fragment of it shows.
    Object.assign(mocks, { rowWidth: 320, metaWidth: 40 });
    act(() => root.unmount());
    root = createRoot(container);
    render(false);
    expect(container.textContent).not.toContain("CEO");
    mocks.metaWidth = 120;
    act(() => root.unmount());
    root = createRoot(container);
    render(false);
    expect(container.textContent).toContain("CEO");
  });

  it("lists an assistant's tasks under it with their state, and opens one on tap", async () => {
    mocks.tasks = [
      { threadId: "w1", title: "Add retry", createdAt: "2026-11-01T00:00:00.000Z" },
      { threadId: "w2", title: "Fix flaky test", createdAt: "2026-11-02T00:00:00.000Z" },
      { threadId: "w3", title: "Old chore", createdAt: "2026-10-01T00:00:00.000Z" },
      {
        threadId: "w4",
        title: "Dismissed chore",
        createdAt: "2026-10-02T00:00:00.000Z",
        dismissedAt: "2026-11-03T00:00:00.000Z",
      },
    ];
    mocks.presence.w1 = { mood: "working", detail: "Working", since: null };
    mocks.presence.w2 = { mood: "failed", detail: "Last run failed", since: null };
    render(false);
    const rows = Array.from(
      container.querySelectorAll('[data-testid="assistant-task-list"] button'),
    ).filter((row) => row.getAttribute("aria-label")?.includes(", "));
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Add retry, Running",
      "Fix flaky test, Failed",
      "Old chore, Done",
    ]);
    await click("Fix flaky test, Failed");
    expect(mocks.open).toHaveBeenCalledWith({ threadId: "w2" });
    // Only finished and failed tasks can be dismissed: the running one has no menu.
    const dismiss = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="menu:Dismiss task"]',
    );
    expect(dismiss).toHaveLength(2);
    await act(async () => dismiss[0]?.click());
    expect(mocks.dismissTask).toHaveBeenCalledWith("w2");
    // A usage-limited task says until when, and can be dismissed like a failed one.
    mocks.tasks = [{ threadId: "w5", title: "Port docs", createdAt: "2026-11-01T00:00:00.000Z" }];
    mocks.presence.w5 = { mood: "limited", detail: "", since: null, resetAt: "2099-01-01T09:30Z" };
    render(false);
    expect(byLabel("Port docs, Limit until <2099-01-01T09:30Z>")).not.toBeNull();
    expect(container.querySelectorAll('[aria-label="menu:Dismiss task"]')).toHaveLength(1);
    mocks.tasks = [];
    render(true);
    expect(container.querySelector('[data-testid="assistant-task-list"]')).toBeNull();
  });

  it("names the environment only when assistants live on several", () => {
    mocks.active = [bot(0, { role: "CEO" }), { ...bot(1), environmentId: "lab" }];
    render(
      true,
      new Map([
        ["hub", "Home Mac"],
        ["lab", "Lab"],
      ]),
    );
    expect(container.textContent).toContain("CEO · Home Mac");
    expect(container.textContent).toContain("Lab");
    mocks.active = make(2);
    render(true, new Map([["hub", "Home Mac"]]));
    expect(container.textContent).not.toContain("Home Mac");
  });

  it("a folder with unread messages offers Mark as read; otherwise Mark as unread", async () => {
    mocks.teams = [
      team("g1", "Busy", [], "hub", { unreadCount: 120, latestSeq: 130 }),
      team("g2", "Quiet", [], "hub", { unreadCount: 0, latestSeq: 5 }),
      team("g3", "Empty", [], "hub", {
        unreadCount: 0,
        latestSeq: 0,
        scopes: [{ projectId: null, unreadCount: 0, waiting: true, readSeq: 0 }],
      }),
    ];
    render();
    // The server's per-tab waiting flag marks the group that waits on the user.
    expect(
      [...container.querySelectorAll('[data-testid="zone-indicator"]')]
        .map((n) => n.textContent)
        .sort(),
    ).toEqual(["120 unread", "Needs you"]);
    expect(container.querySelectorAll('[aria-label="menu:Mark as read"]')).toHaveLength(1);
    const unread = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="menu:Mark as unread"]',
    );
    // Empty waits on the user, so it sorts above Quiet.
    expect([unread[0]!.disabled, unread[1]!.disabled]).toEqual([true, false]);
    await act(async () => byLabel("menu:Mark as read")?.click());
    expect(mocks.markRead).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    await act(async () => unread[1]!.click());
    expect(mocks.markUnread).toHaveBeenCalledWith(expect.objectContaining({ id: "g2" }));
  });

  it("the folder chevron toggles and remembers it; the name opens the chat", async () => {
    mocks.teams = [team("g1", "Finance", ["a0"])];
    render();
    expect(assistantRows()).toEqual(["Bot1"]);
    await click("Show Finance members");
    expect(mocks.toggleGroup).toHaveBeenCalledWith("group:hub:g1");
    expect(mocks.chat).not.toHaveBeenCalled();
    mocks.expandedGroups = ["group:hub:g1"];
    render();
    expect(assistantRows()).toEqual(["Bot1", "Bot0"]);
    expect(byLabel("Hide Finance members")?.getAttribute("aria-expanded")).toBe("true");
    await click("Finance");
    expect(mocks.chat).toHaveBeenCalledWith("hub", "g1");
    mocks.chat.mockClear();
    await click("menu:Open chat");
    expect(mocks.chat).toHaveBeenCalledWith("hub", "g1");
    await click("menu:Archive group");
    expect(mocks.archiveTeam).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    await click("menu:Edit group");
    expect(mocks.openTeam).toHaveBeenCalledWith("hub", "g1");
    await click("menu:New assistant in this group");
    expect(mocks.editor).toHaveBeenCalledWith("hub", null, { teamId: "g1" });
    await click("menu:Group info");
    expect(mocks.info.group).toHaveBeenCalledWith("hub", "g1");
  });

  it("shows active assistants plus five recent ungrouped ones, and Show all reveals the rest", async () => {
    mocks.active = make(10);
    mocks.teams = [team("g1", "Finance", ["a9"])];
    mocks.presence.t8 = { mood: "working", detail: "W", since: null };
    render();
    expect(assistantRows()).toHaveLength(6);
    expect(container.textContent).toContain("Show all (9)");
    await click("Show all");
    expect(mocks.toggleShowAll).toHaveBeenCalledOnce();
    mocks.showAll = true;
    render();
    expect(assistantRows()).toHaveLength(9);
    expect(byLabel("Show less")).not.toBeNull();
    mocks.showAll = false;
    mocks.active = make(3);
    render();
    expect(byLabel("Show all")).toBeNull();
  });

  it("opens a conversation from a row; an assistant without a thread cannot be opened", async () => {
    render();
    await click("Bot1");
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    mocks.active = [bot(0, { threadId: null })];
    render();
    expect(byLabel("Bot0")?.disabled).toBe(true);
  });

  it("a row's menu opens info, resets, opens settings and archives; reset waits while it works", async () => {
    render();
    await click("menu:Assistant info");
    expect(mocks.info.assistant).toHaveBeenCalledWith("hub", "a0");
    await click("menu:Reset conversation");
    expect(mocks.reset).toHaveBeenCalledWith(expect.objectContaining({ id: "a0" }), {
      openAfter: true,
    });
    await click("menu:Bot0 settings");
    expect(mocks.editor).toHaveBeenCalledWith("hub", expect.objectContaining({ id: "a0" }));
    await click("menu:Bot0 work");
    expect(mocks.work).toHaveBeenCalledWith("hub", "a0");
    await click("menu:Archive assistant");
    expect(mocks.archive).toHaveBeenCalledWith(expect.objectContaining({ id: "a0" }));
    // A long press on the row offers the same menu as its ⋯ button.
    expect(container.querySelectorAll('[aria-label="menu:Bot0 work"]')).toHaveLength(2);
    mocks.presence.t0 = { mood: "working", detail: "Working", since: null };
    render();
    expect(byLabel("menu:Reset conversation")?.disabled).toBe(true);
  });

  it("the plus menu offers a new assistant, a new group and the describe flow", async () => {
    render();
    await click("menu:New assistant");
    expect(mocks.editor).toHaveBeenCalledWith("hub", null);
    await click("menu:New group");
    expect(mocks.openTeam).toHaveBeenCalledWith("hub", null);
    await click("menu:Describe one and let T3 build it");
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsAssistantDescribe");
  });

  it("renders nothing without assistants or groups, and collapsed shows the label and a count only", async () => {
    mocks.active = [];
    render();
    expect(container.textContent).toBe("");
    mocks.teams = [team("g1", "Finance", [])];
    render();
    expect(container.textContent).toContain("Finance");
    mocks.active = make(7);
    mocks.teams = [];
    mocks.collapsed = true;
    render();
    expect(container.querySelector('[data-testid="teams-count"]')?.textContent).toBe("7");
    expect(container.querySelector("i")).toBeNull();
    expect(assistantRows()).toEqual([]);
    await click("Teams");
    expect(mocks.toggle).toHaveBeenCalledOnce();
  });

  it("pushed updates redraw no assistant or folder row; only the host's task rows run again", async () => {
    // 37 assistants in 7 groups (some in two), 5 running one task each, 3 more with an idle task.
    mocks.active = make(37);
    mocks.showAll = true;
    mocks.teams = Array.from({ length: 7 }, (_, g) =>
      team(
        `g${g}`,
        `Group ${g}`,
        Array.from({ length: 5 }, (_, m) => `a${(g * 4 + m) % 37}`),
      ),
    );
    mocks.expandedGroups = mocks.teams.map(({ team: t }) => `group:hub:${t.id}`);
    for (const i of [3, 9, 15, 21, 27]) {
      mocks.extraTasks.set(`hub:a${i}`, [
        { threadId: `run-${i}`, title: `Run ${i}`, createdAt: "2026-11-05T00:00:00.000Z" },
      ]);
      mocks.running.add(`run-${i}`);
      mocks.presence[`run-${i}`] = { mood: "working", detail: "W", since: null };
      mocks.presence[`t${i}`] = { mood: "working", detail: "W", since: null };
    }
    for (const i of [30, 31, 32]) {
      mocks.extraTasks.set(`hub:a${i}`, [
        { threadId: `idle-${i}`, title: `Idle ${i}`, createdAt: "2026-11-04T00:00:00.000Z" },
      ]);
    }
    const renderThread = vi.fn(hostRow);
    await render(true, new Map(), { renderThread: renderThread as never });
    expect(assistantRows()).toHaveLength(37);
    expect(hostRows()).toHaveLength(8);
    mocks.workRenders = 0;
    mocks.teamRenders = 0;
    renderThread.mockClear();
    for (let update = 0; update < 50; update += 1) await pushShellUpdate();
    // Assistant and folder rows read plain props only.
    expect([mocks.workRenders, mocks.teamRenders]).toEqual([0, 0]);
    // Calls to the host's row function (a stand-in here): every drawn task row, idle ones too,
    // because the task sections are rebuilt on each change.
    expect(renderThread.mock.calls.length / 50).toBe(8);
    // The assistant list wraps every entry anew on each change; the rows still hold.
    mocks.active = mocks.active.map((entry) => ({ ...entry }));
    mocks.teams = mocks.teams.map((entry) => ({ ...entry }));
    await pushShellUpdate();
    expect([mocks.workRenders, mocks.teamRenders]).toEqual([0, 0]);
  });
});
