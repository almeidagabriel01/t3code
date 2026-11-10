import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: { task: null as unknown, setTaskDismissed: vi.fn() },
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
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
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
    task === null ? null : { dismissed: task.dismissedAt !== null, canDismiss: true },
}));
vi.mock("../../state/assistants", () => ({ useAssistantTask: () => mocks.task }));
vi.mock("../assistants/useAssistantFlows", () => ({ setTaskDismissed: mocks.setTaskDismissed }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { set: vi.fn() } }));
vi.mock("../../state/thread-order", () => ({ threadArrangementOpenAtom: {} }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { visit: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./use-visible-second-clock", () => ({ useVisibleSecondClock: () => 0 }));
vi.mock("../../lib/clock", () => ({ useNowAfter: () => 0 }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
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
  ThreadSwipeable: (props: { children: (close: () => void) => ReactNode }) => (
    <div>{props.children(() => {})}</div>
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

import { ThreadListV2Row } from "./thread-list-v2-items";

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

async function mount() {
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
