import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { atoms, mocks, Children } = vi.hoisted(() => {
  const names = [
    "threads",
    "configs",
    "listEnvironments",
    "queued",
    "pending",
    "busy",
    "open",
  ] as const;
  return {
    atoms: Object.fromEntries(names.map((name) => [name, { name }])) as Record<
      (typeof names)[number],
      { name: string }
    >,
    mocks: { values: new Map<object, unknown>(), threadOrder: "activity" as "activity" | "fixed" },
    Children: ({ children }: { children?: ReactNode }) => children,
  };
});

vi.mock("react-native", () => ({
  View: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityActions?: ReadonlyArray<{ label: string }>;
  }) => (
    <div
      aria-label={props.accessibilityLabel}
      data-actions={props.accessibilityActions?.map((action) => action.label).join(",")}
    >
      {props.children}
    </div>
  ),
  Animated: { Value: function Value() {}, View: Children },
  FlatList: (props: {
    data: ReadonlyArray<{ key: string }>;
    renderItem: (info: { item: { key: string } }) => ReactNode;
  }) => props.data.map((item) => <div key={item.key}>{props.renderItem({ item })}</div>),
  Modal: Children,
  Pressable: Children,
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock("react-native-gesture-handler", () => {
  const pan: Record<string, unknown> = {};
  for (const name of ["enabled", "minDistance", "shouldCancelWhenOutside", "runOnJS"])
    pan[name] = () => pan;
  for (const name of ["onStart", "onUpdate", "onEnd", "onFinalize"]) pan[name] = () => pan;
  return {
    Gesture: { Pan: () => pan },
    GestureDetector: Children,
    GestureHandlerRootView: Children,
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: Children },
  ReduceMotion: { System: "system" },
  useAnimatedStyle: () => ({}),
  withTiming: (value: number) => value,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: Children,
  SafeAreaView: Children,
}));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../lib/layout", () => ({
  deriveThreadArrangementSizing: () => ({ rowHeight: 50, headerHeight: 30 }),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { set: vi.fn() } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (atom: object) => mocks.values.get(atom) }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: atoms.configs }));
vi.mock("../../state/presentation", () => ({ threadListEnvironmentsAtom: atoms.listEnvironments }));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { navigationThreadShellsAtom: atoms.threads },
}));
vi.mock("../../state/olderSettledShelf", () => ({
  useOlderSettledShelf: () => ({
    isListed: () => true,
    unloadedCount: () => 0,
    loading: false,
    failed: false,
    retry: () => {},
  }),
  useOlderSettledShelfGrowth: () => {},
}));
vi.mock("../../state/thread-order", () => ({
  pendingThreadOrderAtom: atoms.pending,
  threadDropBusyAtom: atoms.busy,
  threadArrangementOpenAtom: atoms.open,
}));
vi.mock("../../state/use-thread-outbox", () => ({ queuedThreadKeysAtom: atoms.queued }));
vi.mock("../home/useThreadListActions", () => ({
  useThreadListActions: () => ({ moveThread: vi.fn() }),
}));
vi.mock("./use-thread-list-now", () => ({ useThreadListNow: () => "2026-06-02T00:00:00.000Z" }));
vi.mock("./use-thread-list-v2-shelf-preferences", () => ({
  useThreadListV2ShelfPreferences: () => ({ threadOrder: mocks.threadOrder }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 16 } }),
}));

import { makeThreadShellFixture } from "../../test-fixtures";
import { ThreadArrangementHost } from "./ThreadArrangementSheet";

const environmentId = EnvironmentId.make("environment-1");

async function render(threadOrder: "activity" | "fixed") {
  mocks.threadOrder = threadOrder;
  const thread = (id: string, activeOrderKey: string) =>
    makeThreadShellFixture({
      environmentId,
      id: ThreadId.make(id),
      title: id,
      activeOrderKey,
    });
  mocks.values = new Map<object, unknown>([
    [atoms.threads, [thread("first", "a"), thread("second", "b")]],
    [atoms.configs, new Map([[environmentId, {}]])],
    [
      atoms.listEnvironments,
      {
        pinReorderEnvironmentIds: new Set([environmentId]),
        activeReorderEnvironmentIds: new Set([environmentId]),
      },
    ],
    [atoms.queued, new Set()],
    [atoms.pending, null],
    [atoms.busy, false],
    [atoms.open, true],
  ]);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<ThreadArrangementHost />));
  const actions = (title: string) =>
    container.querySelector(`[aria-label="Reorder ${title}"]`)?.getAttribute("data-actions");
  return { actions, unmount: () => act(async () => root.unmount()) };
}

describe("ThreadArrangementSheet", () => {
  it("lets active threads step in the fixed order only", async () => {
    const fixed = await render("fixed");
    expect(fixed.actions("second")).toContain("Move up");
    expect(fixed.actions("first")).toContain("Move down");
    await fixed.unmount();

    const activity = await render("activity");
    expect(activity.actions("second")).not.toContain("Move up");
    expect(activity.actions("first")).not.toContain("Move down");
    await activity.unmount();
  });
});
