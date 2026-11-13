import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    task: null as unknown,
    canDismiss: true,
    setTaskDismissed: vi.fn(),
    copyText: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 400, fontScale: 1 }),
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Text: (props: { children?: ReactNode }) => <span>{props.children}</span>,
  Pressable: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: (props: { name: string }) => <s>{props.name}</s>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: ReadonlyArray<{ id?: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <div>
      {props.actions.map((action) => (
        <button
          key={action.id}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id ?? "" } })}
        >
          {action.title}
        </button>
      ))}
      {props.children}
    </div>
  ),
}));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/ProviderIcon", () => ({
  ProviderIcon: () => null,
  ProviderInstanceIcon: () => null,
}));
vi.mock("./thread-list-v2-row-appearance", () => ({
  THREAD_LIST_V2_MONO_FONT: "mono",
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME: "",
  THREAD_LIST_V2_ROW_DIVIDERS: false,
  selectedThreadRowColors: {},
  getThreadListV2NewBranchMenuTitle: (branch: string) => branch,
  getThreadListV2RowAppearance: () => ({}),
}));
vi.mock("./CustomSnoozeSheet", () => ({ CustomSnoozeSheet: () => null }));
vi.mock("@t3tools/client-runtime/assistantTasks", () => ({
  assistantTaskMenuState: (task: { dismissedAt: string | null } | null) =>
    task === null ? null : { dismissed: task.dismissedAt !== null, canDismiss: mocks.canDismiss },
}));
vi.mock("../../state/assistants", () => ({ useAssistantTask: () => mocks.task }));
vi.mock("../assistants/useAssistantFlows", () => ({ setTaskDismissed: mocks.setTaskDismissed }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { set: vi.fn() } }));
vi.mock("../../state/thread-order", () => ({ threadArrangementOpenAtom: {} }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { visit: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./use-visible-second-clock", () => ({ useVisibleSecondClock: () => 0 }));
vi.mock("../../lib/clock", () => ({ useNowAfter: () => 0 }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: mocks.copyText }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => "light" }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/pending-new-tasks-model", () => ({
  pendingDraftBranchNeedsRefs: () => false,
  resolvePendingDraftBranch: () => null,
}));
vi.mock("../../state/queries", () => ({ useBranches: () => ({}) }));
vi.mock("./use-new-task-project-defaults", () => ({ useNewTaskProjectDefaults: () => ({}) }));
vi.mock("../../state/thread-pr-presentation", () => ({ resolveThreadPrBadgeAction: () => ({}) }));
vi.mock("../../state/use-thread-pr", () => ({ useThreadPr: () => null }));
vi.mock("../home/swipe-row-activation", () => ({ useSwipeRowDormant: () => false }));
vi.mock("../home/thread-swipe-actions", () => ({
  ThreadSwipeable: (props: {
    compactActions: boolean;
    primaryAction: { label: string; onPress: () => void };
    children: (close: () => void) => ReactNode;
  }) => (
    <div data-compact={String(props.compactActions)}>
      <button onClick={props.primaryAction.onPress}>{`swipe:${props.primaryAction.label}`}</button>
      {props.children(() => {})}
    </div>
  ),
}));
vi.mock("./openThreadHandoff", () => ({ openThreadHandoff: vi.fn() }));
vi.mock("./thread-handoff", () => ({ canHandoffThread: () => false }));
vi.mock("./copyThreadMenuReference", () => ({ copyThreadMenuReference: vi.fn() }));
vi.mock("./turnThreadIntoProject", () => ({
  canTurnThreadIntoProject: () => false,
  turnThreadIntoProject: vi.fn(),
}));
vi.mock("../home/threadArchive", () => ({ threadCanArchive: () => false }));
vi.mock("./queued-message-icon", () => ({ QueuedMessageIcon: () => null }));
vi.mock("./thread-row-emphasis", () => ({ shouldRecedeThreadRow: () => false }));
vi.mock("./thread-search-match", () => ({ ThreadSearchMatchExcerpt: () => null }));
vi.mock("../settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16, lineHeight: 20 }),
}));
vi.mock("../pull-requests/pullRequestGlyphs", () => ({ PullRequestGlyph: {} }));
vi.mock("../pull-requests/pullRequestStatus", () => ({ pullRequestStatus: () => ({}) }));

import { ThreadListV2Row, ThreadListV2SubagentRow } from "./thread-list-v2-items";

const thread = {
  environmentId: "env",
  id: "t1",
  title: "Nightly report",
  projectId: "p1",
  branch: null,
  runtime: null,
  latestRun: null,
  modelSelection: { instanceId: "codex" },
  pinnedAt: null,
  autoSettleDisabledAt: null,
  titleRegeneration: null,
  settledOverride: null,
} as never;

async function mount(overrides: Record<string, unknown> = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = window.document.createElement("div");
  const noop = vi.fn();
  await act(() =>
    createRoot(container).render(
      <ThreadListV2Row
        {...({
          thread,
          variant: "card",
          timeLabel: "1m",
          settlementSupported: false,
          snoozeSupported: false,
          snoozePresets: undefined,
          pinningSupported: false,
          autoSettleOptOutSupported: false,
          titleRegenerationSupported: false,
          onSelectThread: noop,
          onOpenThreadPullRequests: noop,
          onDeleteThread: noop,
          onRenameThread: noop,
          onRegenerateThreadTitle: noop,
          onNewThreadOnBranch: noop,
          onSettleThread: noop,
          onSnoozeThread: noop,
          onUnsnoozeThread: noop,
          onUnsettleThread: noop,
          onArchiveThread: noop,
          onPinThread: noop,
          onUnpinThread: noop,
          onSetThreadAutoSettle: noop,
          onSwipeableWillOpen: noop,
          onSwipeableClose: noop,
          wokeAt: null,
          ...overrides,
        } as unknown as Parameters<typeof ThreadListV2Row>[0])}
      />,
    ),
  );
  return container;
}

const press = (container: HTMLElement, title: string) =>
  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === title)!
      .click(),
  );

describe("ThreadListV2Row assistant task menu", () => {
  beforeEach(() => mocks.setTaskDismissed.mockReset());

  it("dismisses a finished task from the row menu", async () => {
    mocks.task = { dismissedAt: null };
    const container = await mount();
    await press(container, "Dismiss task");
    expect(mocks.setTaskDismissed).toHaveBeenCalledWith("env", "t1", true);
  });

  it("restores a dismissed task from the row menu", async () => {
    mocks.task = { dismissedAt: "2026-10-01T00:00:00.000Z" };
    const container = await mount();
    await press(container, "Restore task");
    expect(mocks.setTaskDismissed).toHaveBeenCalledWith("env", "t1", false);
  });

  it("offers no task item on a thread that is no task", async () => {
    mocks.task = null;
    const container = await mount();
    expect(container.textContent).not.toMatch(/Dismiss task|Restore task/);
  });
});

describe("ThreadListV2Row assistant task swipe", () => {
  beforeEach(() => {
    mocks.setTaskDismissed.mockReset();
    mocks.canDismiss = true;
  });

  it("swipes a done or failed task to Dismiss in the assistants section, keeping Settle in the menu", async () => {
    mocks.task = { dismissedAt: null };
    const row = await mount({ compact: true, settlementSupported: true });
    await press(row, "swipe:Dismiss");
    expect(mocks.setTaskDismissed).toHaveBeenCalledWith("env", "t1", true);
    expect(row.textContent).toContain("Settle");
    expect(row.textContent).toContain("Dismiss task");
  });

  it.each([
    ["a task still running", true, false],
    ["a done task in the project list", false, true],
  ] as const)("swipes %s to Settle", async (_name, compact, canDismiss) => {
    mocks.task = { dismissedAt: null };
    mocks.canDismiss = canDismiss;
    const row = await mount({ compact, settlementSupported: true });
    expect(row.textContent).toContain("swipe:Settle");
  });
});

describe("ThreadListV2Row compact", () => {
  it("keeps the menu but drops arranging, and shows the pin and live status on one line", async () => {
    mocks.task = null;
    const list = await mount({ pinningSupported: true, reorderSupported: true });
    expect(list.textContent).toContain("Arrange threads…");
    expect(list.querySelector("[data-compact]")?.getAttribute("data-compact")).toBe("false");
    const working = {
      ...(thread as object),
      pinnedAt: "2026-11-01T00:00:00.000Z",
      runtime: { status: "running" },
      latestRun: { requestedAt: "2026-11-01T00:00:00.000Z", completedAt: null },
    };
    const compact = await mount({
      thread: working,
      pinned: true,
      compact: true,
      pinningSupported: true,
      reorderSupported: true,
    });
    expect(compact.textContent).not.toContain("Arrange threads…");
    expect(compact.querySelector("[data-compact]")?.getAttribute("data-compact")).toBe("true");
    expect(compact.textContent).toContain("Unpin");
    const symbols = [...compact.querySelectorAll("s")].map((symbol) => symbol.textContent);
    expect(symbols).toContain("pin");
    expect(symbols).toContain("circle.dashed");
  });
});

describe("ThreadListV2SubagentRow menu", () => {
  it("pins, unpins and copies from the long-press menu, and has none in the project list", async () => {
    const onSetPinned = vi.fn();
    const mountChild = async (child: object, menu: boolean) => {
      const container = window.document.createElement("div");
      await act(() =>
        createRoot(container).render(
          <ThreadListV2SubagentRow
            thread={{ ...(thread as object), ...child } as never}
            onSelectThread={vi.fn()}
            {...(menu ? { menu: { pinningSupported: true, onSetPinned } } : {})}
          />,
        ),
      );
      return container;
    };
    const loose = await mountChild({}, true);
    await press(loose, "Pin");
    await press(loose, "Copy thread");
    await press(loose, "Copy thread ID");
    expect(mocks.copyText).toHaveBeenCalledWith("t1", { target: "thread-id" });
    // A finished pinned child stays under its assistant: Done, with Unpin in its menu.
    const finished = await mountChild({ pinnedAt: "2026-11-01T00:00:00.000Z" }, true);
    expect([...finished.querySelectorAll("s")].map((symbol) => symbol.textContent)).toContain(
      "checkmark.circle",
    );
    await press(finished, "Unpin");
    expect(onSetPinned.mock.calls.map(([, pinned]) => pinned)).toEqual([true, false]);
    expect((await mountChild({}, false)).querySelector("button")).toBeNull();
  });
});
