import type { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    states: [] as unknown[],
    prompt: vi.fn(),
    alert: vi.fn(),
    updateCard: vi.fn(),
    setCardProblemIgnored: vi.fn(),
    navigate: vi.fn(),
    markdown: vi.fn((_props: { markdown: string; preserveSoftBreaks?: boolean }) => null),
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Linking: { openURL: vi.fn() },
  TextInput: () => null,
  Pressable: (props: {
    accessibilityLabel?: string;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate, goBack: vi.fn() }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress?: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/Dialog", () => ({
  prompt: mocks.prompt,
  alert: mocks.alert,
  confirm: vi.fn(),
}));
vi.mock("../../components/ui/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: mocks.markdown,
}));
vi.mock("../threads/ThreadMarkdownImage", () => ({ ThreadMarkdownImage: () => null }));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
vi.mock("../threads/useOpenLinkedThread", () => ({ useOpenLinkedThread: () => vi.fn() }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./KanbanAddAttachmentButton", () => ({ KanbanAddAttachmentButton: () => null }));
vi.mock("./KanbanCardAttachments", () => ({
  KanbanCardAttachmentList: () => null,
  KanbanCardCoverImage: () => null,
}));
vi.mock("./KanbanCardTile", () => ({ KanbanLabelChip: () => null }));
vi.mock("./useStartKanbanAgent", () => ({
  useStartKanbanAgent: () => ({ starting: false, ready: true, start: vi.fn() }),
}));
vi.mock("./useKanbanActions", () => ({
  useKanbanActions: () => ({
    canEdit: true,
    updateCard: mocks.updateCard,
    setCardProblemIgnored: mocks.setCardProblemIgnored,
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, refresh: vi.fn() }),
}));
vi.mock("../../state/kanban", () => ({
  kanbanEnvironment: { card: () => "card" },
  useKanbanStates: () => mocks.states,
}));

import { KanbanCardRouteScreen } from "./KanbanCardRouteScreen";

const environmentId = "env" as EnvironmentId;
const card = {
  id: "c1",
  boardId: "b0",
  columnId: "todo",
  orderKey: "a",
  number: 7,
  title: "Fix it",
  description: "",
  priority: "medium",
  type: null,
  labelIds: [],
  estimate: null,
  coverAttachmentId: null,
  parentCardId: null,
  attachments: [],
  linkedThreadIds: [],
  checklist: [],
  acceptanceCriteria: [],
  dueAt: "2026-03-05T12:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.prompt.mockReset();
  mocks.alert.mockReset();
  mocks.updateCard.mockReset();
  mocks.setCardProblemIgnored.mockReset();
  mocks.navigate.mockReset();
  mocks.markdown.mockClear();
  mocks.states = [
    {
      environmentId,
      state: {
        boards: new Map([
          [
            "b0",
            {
              id: "b0",
              projectId: "p1",
              columns: [{ id: "todo", boardId: "b0", name: "Todo", orderKey: "a", role: "todo" }],
              cards: new Map([["c1", card]]),
              labels: [],
              templates: [],
            },
          ],
        ]),
      },
      error: false,
    },
  ];
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

const mount = () =>
  act(async () =>
    root.render(
      <KanbanCardRouteScreen route={{ params: { environmentId, cardId: "c1" } } as never} />,
    ),
  );
const press = (label: string) =>
  act(async () => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.click());

describe("KanbanCardRouteScreen due date", () => {
  it("prompts with the current date and saves the new one on the card", async () => {
    await mount();
    await press("Due date");
    expect(mocks.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Due date", initialValue: "2026-03-05" }),
    );
    await act(async () => mocks.prompt.mock.calls[0]![0].onConfirm("2026-04-01"));
    expect(mocks.updateCard).toHaveBeenCalledWith({
      cardId: "c1",
      dueAt: expect.stringContaining("2026-04-01"),
    });
    await act(async () => mocks.prompt.mock.calls[0]![0].onConfirm(""));
    expect(mocks.updateCard).toHaveBeenLastCalledWith({ cardId: "c1", dueAt: null });
  });
});

describe("KanbanCardRouteScreen description", () => {
  it("keeps single-newline lines apart", async () => {
    const board = (
      mocks.states[0] as { state: { boards: Map<string, { cards: Map<string, unknown> }> } }
    ).state.boards.get("b0")!;
    const description = "Command: pnpm install\nError: ERR_PNPM_FETCH_404\nWhere: Linux";
    board.cards = new Map([["c1", { ...card, description }]]);
    await mount();
    expect(mocks.markdown).toHaveBeenLastCalledWith(
      expect.objectContaining({ markdown: description, preserveSoftBreaks: true }),
      undefined,
    );
  });
});

describe("KanbanCardRouteScreen problem block", () => {
  const withCards = (...cards: ReadonlyArray<Record<string, unknown>>) => {
    const board = (
      mocks.states[0] as { state: { boards: Map<string, { cards: Map<string, unknown> }> } }
    ).state.boards.get("b0")!;
    board.cards = new Map(cards.map((entry) => [entry.id as string, entry]));
  };

  it.each([
    {
      problem: { kind: "ci", count: 4, ownerName: "Jarvis", previousCardNumber: 3, ignored: false },
      lines: ["Seen 4 times", "Handled by Jarvis"],
      action: "Ignore this problem",
      ignored: true,
    },
    {
      problem: { kind: "ci", count: 1, ownerName: null, previousCardNumber: null, ignored: true },
      lines: [],
      action: "Stop ignoring",
      ignored: false,
    },
  ])("shows $lines and sends $action", async ({ problem, lines, action, ignored }) => {
    withCards({ ...card, problem }, { ...card, id: "c0", number: 3, title: "Old" });
    await mount();
    for (const line of lines) expect(host.textContent).toContain(line);
    if (problem.count === 1) expect(host.textContent).not.toContain("Seen");
    if (problem.previousCardNumber !== null) {
      await press("Previous card: #3");
      expect(mocks.navigate).toHaveBeenCalledWith("SettingsKanbanCard", {
        environmentId,
        cardId: "c0",
      });
    } else {
      expect(host.querySelector('[aria-label^="Previous card"]')).toBeNull();
    }
    await press(action);
    expect(mocks.setCardProblemIgnored).toHaveBeenCalledWith({ cardId: "c1", ignored });
  });

  it("shows nothing for an ordinary card", async () => {
    await mount();
    expect(host.querySelector('[aria-label="Ignore this problem"]')).toBeNull();
  });
});
