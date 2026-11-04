import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    canEdit: true,
    card: null as unknown,
    messages: null as unknown,
    states: [] as unknown[],
    navigate: vi.fn(),
    goBack: vi.fn(),
    unlinkCardThread: vi.fn(),
    linkCardThread: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: {
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  FlatList: (props: {
    data: ReadonlyArray<unknown>;
    renderItem: (info: { item: never }) => ReactNode;
  }) => <>{props.data.map((item) => props.renderItem({ item: item as never }))}</>,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate, goBack: mocks.goBack }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string }) => <p>{props.title}</p>,
}));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: ReadonlyArray<{ id: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <div>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          data-action={action.id}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </div>
  ),
}));
vi.mock("../../state/kanban", () => ({
  useThreadKanbanCard: () => mocks.card,
  useKanbanStates: () => mocks.states,
}));
vi.mock("../../state/entities", () => ({ useThreadMessages: () => mocks.messages }));
vi.mock("./useKanbanActions", () => ({
  useKanbanActions: () => ({
    canEdit: mocks.canEdit,
    unlinkCardThread: mocks.unlinkCardThread,
    linkCardThread: mocks.linkCardThread,
  }),
}));

import { KanbanLinkCardRouteScreen } from "./KanbanLinkCardRouteScreen";
import { ThreadComposerKanbanCardChip } from "./ThreadComposerKanbanCardChip";
import { ThreadKanbanCardChip } from "./ThreadKanbanCardChip";

const environmentId = "env" as EnvironmentId;
const threadId = "thread" as ThreadId;
const current = { id: "c1", number: 7, title: "Fix it" };
const other = { id: "c2", number: 8, title: "Another" };

let root: Root;
let host: HTMLElement;
const mount = (ui: ReactNode) => act(() => root.render(ui));
const click = (selector: string) =>
  act(async () => {
    (host.querySelector(selector) as HTMLElement).click();
  });
const labelled = (label: string) => `[aria-label="${label}"]`;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = window.document.createElement("div");
  root = createRoot(host);
  mocks.canEdit = true;
  mocks.card = current;
  mocks.messages = [];
  mocks.states = [
    {
      environmentId,
      state: {
        boards: new Map([
          [
            "b",
            {
              projectId: "p1",
              cards: new Map([
                ["c1", current],
                ["c2", other],
              ]),
            },
          ],
        ]),
      },
    },
  ];
  mocks.navigate.mockReset();
  mocks.goBack.mockReset();
  mocks.unlinkCardThread.mockReset().mockResolvedValue(true);
  mocks.linkCardThread.mockReset().mockResolvedValue(true);
});
afterEach(() => act(() => root.unmount()));

describe("ThreadKanbanCardChip", () => {
  it("opens, switches and unlinks from the menu", async () => {
    await mount(<ThreadKanbanCardChip environmentId={environmentId} threadId={threadId} />);
    await click('[data-action="open"]');
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsKanbanCard", {
      environmentId,
      cardId: "c1",
    });
    await click('[data-action="switch"]');
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsKanbanLinkCard", {
      environmentId,
      threadId,
    });
    await click('[data-action="unlink"]');
    expect(mocks.unlinkCardThread).toHaveBeenCalledWith({ cardId: "c1", threadId });
  });

  it("offers only Open to a read-only session and nothing without a card", async () => {
    mocks.canEdit = false;
    await mount(<ThreadKanbanCardChip environmentId={environmentId} threadId={threadId} />);
    expect(host.querySelectorAll("[data-action]")).toHaveLength(1);
    mocks.card = null;
    await mount(<ThreadKanbanCardChip environmentId={environmentId} threadId={threadId} />);
    expect(host.innerHTML).toBe("");
  });
});

describe("ThreadComposerKanbanCardChip", () => {
  const ref = { environmentId, threadId } as ScopedThreadRef;

  it("removes the card from the next message and adds it back", async () => {
    await mount(<ThreadComposerKanbanCardChip environmentId={environmentId} threadRef={ref} />);
    await click(labelled("Send without the card"));
    expect(host.textContent).toContain("left out");
    await click(labelled("Send #7 Fix it with this message"));
    expect(host.querySelector(labelled("Send without the card"))).not.toBeNull();
  });

  it("hides when the card was delivered, the history is unloaded or there is no thread", async () => {
    mocks.messages = [{ context: { records: [{ kind: "kanban-card", cardId: "c1" }] } }];
    await mount(<ThreadComposerKanbanCardChip environmentId={environmentId} threadRef={ref} />);
    expect(host.innerHTML).toBe("");
    mocks.messages = null;
    await mount(<ThreadComposerKanbanCardChip environmentId={environmentId} threadRef={ref} />);
    expect(host.innerHTML).toBe("");
    await mount(<ThreadComposerKanbanCardChip environmentId={environmentId} threadRef={null} />);
    expect(host.innerHTML).toBe("");
  });
});

describe("KanbanLinkCardRouteScreen", () => {
  const screen = () => (
    <KanbanLinkCardRouteScreen route={{ params: { environmentId, threadId } } as never} />
  );

  it("unlinks the current card, then links the picked one", async () => {
    await mount(screen());
    await click("button:not([disabled])");
    expect(mocks.unlinkCardThread).toHaveBeenCalledWith({ cardId: "c1", threadId });
    expect(mocks.linkCardThread).toHaveBeenCalledWith({ cardId: "c2", threadId });
    expect(mocks.goBack).toHaveBeenCalledOnce();
  });

  it("stays when the unlink fails and shows an empty state without a card", async () => {
    mocks.unlinkCardThread.mockResolvedValue(false);
    await mount(screen());
    await click("button:not([disabled])");
    expect(mocks.linkCardThread).not.toHaveBeenCalled();
    mocks.card = null;
    await mount(screen());
    expect(host.textContent).toContain("No cards found");
  });

  it("links an unlinked thread to a card of its project's board", async () => {
    mocks.card = null;
    await mount(
      <KanbanLinkCardRouteScreen
        route={{ params: { environmentId, threadId, projectId: "p1" } } as never}
      />,
    );
    await click("button:not([disabled])");
    expect(mocks.unlinkCardThread).not.toHaveBeenCalled();
    expect(mocks.linkCardThread).toHaveBeenCalledWith({ cardId: "c2", threadId });
    expect(mocks.goBack).toHaveBeenCalledOnce();
  });
});
