import { NoteError, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    startWork: vi.fn(),
    back: vi.fn(),
    preventRemove: false,
    uuid: 0,
    note: {} as { project?: string },
  },
}));
vi.mock("react-native", () => ({ View: Children, Pressable: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mocks.back }),
  usePreventRemove: (prevent: boolean) => {
    mocks.preventRemove = prevent;
  },
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: { title: string; children?: ReactNode }) => (
    <>
      <h1>{props.title}</h1>
      {props.children}
    </>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: {
    label: string;
    disabled?: boolean;
    loading?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={props.disabled || props.loading} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => `request-${++mocks.uuid}` }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    {
      environmentId: "hub",
      id: "api",
      title: "Api",
      workspaceRoot: "/code/api",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    {
      environmentId: "hub",
      id: "web",
      title: "Web",
      workspaceRoot: "/code/web",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  useThreadShells: () => [],
}));
vi.mock("../../state/kanban", () => ({ useKanbanStates: () => [] }));
vi.mock("../../state/notes", () => ({
  notesEnvironment: { startWork: {} },
  useNotesFeed: () => AsyncResult.success({ notes: new Map([["ideas/note.md", mocks.note]]) }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.startWork }));
vi.mock("./NoteCard", () => ({
  NoteCardSection: (props: { link: { cardId: string } }) => <p>Card {props.link.cardId}</p>,
}));
vi.mock("./notes-state", () => ({
  notesCommandOptions: {},
  useNoteDraftAccess: () => ({ canAct: true }),
}));

import { NoteStartWorkRouteScreen } from "./NoteStartWorkRouteScreen";

const props = {
  route: { params: { environmentId: "hub", path: "ideas/note.md" } },
} satisfies ComponentProps<typeof NoteStartWorkRouteScreen>;
let root: Root;
let container: HTMLDivElement;
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.startWork.mockReset();
  mocks.back.mockReset();
  mocks.preventRemove = false;
  mocks.note = {};
});
afterEach(() => act(() => root.unmount()));

it("retries with the same request id so a lost response cannot create a second card", async () => {
  const first = Promise.withResolvers<unknown>();
  mocks.startWork
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(AsyncResult.success({ note: {}, boardId: "board", cardId: "card-1" }));
  await act(async () => root.render(<NoteStartWorkRouteScreen {...props} />));
  act(() => button("Start work").click());
  expect(mocks.preventRemove).toBe(true);
  await act(async () =>
    first.resolve(
      AsyncResult.failure(Cause.fail(new NoteError({ reason: "storage", message: "Timed out" }))),
    ),
  );
  expect(mocks.preventRemove).toBe(false);
  expect(container.textContent).toContain("Timed out");
  await act(async () => button("Try again").click());
  const [firstCall, retry] = mocks.startWork.mock.calls.map(([value]) => value);
  expect(retry).toEqual(firstCall);
  expect(retry).toMatchObject({
    environmentId: "hub",
    input: { path: "ideas/note.md", projectId: ProjectId.make("web") },
  });
  expect(container.textContent).toContain("Card card-1");
  expect(container.textContent).toContain("Card created");
});

it("defaults to the project the note belongs to", async () => {
  mocks.note = { project: "api" };
  mocks.startWork.mockResolvedValue(
    AsyncResult.success({ note: {}, boardId: "board", cardId: "c" }),
  );
  await act(async () => root.render(<NoteStartWorkRouteScreen {...props} />));
  await act(async () => button("Start work").click());
  expect(mocks.startWork.mock.calls[0]![0].input.projectId).toBe(ProjectId.make("api"));
});
