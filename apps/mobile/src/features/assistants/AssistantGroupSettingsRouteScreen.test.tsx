import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    target: null as null | { environmentId: string; teamId: string | null },
    teams: [] as unknown[],
    chat: null as null | { messages: Map<string, { seq: number; kind: string }> },
    canConverse: true,
    update: vi.fn(),
    conversation: vi.fn(),
    goBack: vi.fn(),
    confirm: vi.fn(),
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.target }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: mocks.goBack }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({
  confirm: (request: { onConfirm: () => void }) => {
    mocks.confirm(request);
    request.onConfirm();
  },
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { children?: ReactNode; footer?: string }) => (
    <section>
      {props.children}
      <p>{props.footer}</p>
    </section>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./AssistantFormFields", () => ({
  TextField: (props: { label: string; value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));
vi.mock("./assistantTeamTarget", () => ({ assistantTeamTargetAtom: {} }));
vi.mock("./GroupRoutinesSection", () => ({ GroupRoutinesSection: () => null }));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ teams: mocks.teams }),
  useAssistantTeamActions: () => ({ canAct: true, update: mocks.update }),
  useAssistantGroupActions: () => ({
    canConverse: mocks.canConverse,
    conversation: mocks.conversation,
  }),
  useAssistantGroupChat: () => mocks.chat,
}));

import { AssistantGroupSettingsRouteScreen } from "./AssistantGroupSettingsRouteScreen";

const team = (extra: object = {}) => ({
  id: "t1",
  name: "Growth",
  memberIds: [],
  leadId: null,
  instructions: "Be brief.",
  memories: ["Budget is 5k"],
  ...extra,
});

let root: Root;
let container: HTMLDivElement;
const buttonNamed = (name: string) =>
  Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === name);
const press = (name: string) => act(async () => buttonNamed(name)?.click());
const write = (label: string, value: string) =>
  act(async () => {
    const field = container.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
const render = () => act(async () => root.render(<AssistantGroupSettingsRouteScreen />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  Object.assign(mocks, {
    target: { environmentId: "hub", teamId: "t1" },
    teams: [{ environmentId: "hub", team: team() }],
    chat: null,
    canConverse: true,
  });
  for (const fn of [mocks.update, mocks.conversation, mocks.goBack, mocks.confirm]) fn.mockReset();
  mocks.update.mockResolvedValue({ ok: true, value: {} });
  mocks.conversation.mockResolvedValue({ ok: true, value: undefined });
});
afterEach(() => act(() => root.unmount()));

describe("group settings", () => {
  it("asks to open a group first when none is chosen", async () => {
    mocks.target = null;
    await render();
    expect(container.textContent).toContain("Open a group first.");
  });

  it("saves instructions and one memory per line, dropping blank lines", async () => {
    await render();
    expect(buttonNamed("Save")?.disabled).toBe(true);
    await write("Group instructions", "  Answer in Portuguese.  ");
    await write("Group memories", "Budget is 5k\n\n  The year starts in March  \n");
    await press("Save");
    expect(mocks.update).toHaveBeenCalledWith({
      teamId: "t1",
      instructions: "Answer in Portuguese.",
      memories: ["Budget is 5k", "The year starts in March"],
    });
    expect(mocks.goBack).toHaveBeenCalled();
  });

  it("a refused save stays on the screen and says why", async () => {
    mocks.update.mockResolvedValue({ ok: false, message: "Nope." });
    await render();
    await write("Group memories", "");
    await press("Save");
    expect(container.textContent).toContain("Nope.");
    expect(mocks.goBack).not.toHaveBeenCalled();
  });

  it("starts a new conversation or compacts without asking, and clear asks first", async () => {
    await render();
    await press("New conversation");
    expect(mocks.conversation).toHaveBeenLastCalledWith("t1", "new");
    await press("Compact context");
    expect(mocks.conversation).toHaveBeenLastCalledWith("t1", "compact");
    expect(mocks.confirm).not.toHaveBeenCalled();
    await press("Clear history");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));
    expect(mocks.conversation).toHaveBeenLastCalledWith("t1", "clear");
  });

  it("offers no Undo while the chat does not end with a divider", async () => {
    mocks.chat = { messages: new Map([["a", { seq: 1, kind: "message" }]]) };
    await render();
    expect(buttonNamed("Undo divider")).toBeUndefined();
  });

  it("offers Undo when a divider ends the chat, and shows a refusal", async () => {
    mocks.chat = {
      messages: new Map([
        ["a", { seq: 1, kind: "message" }],
        ["b", { seq: 2, kind: "boundary" }],
      ]),
    };
    mocks.conversation.mockResolvedValue({ ok: false, message: "Too late." });
    await render();
    await press("Undo divider");
    expect(mocks.conversation).toHaveBeenLastCalledWith("t1", "undo");
    expect(container.textContent).toContain("Too late.");
  });

  it("holds the conversation actions while the group works or access is missing", async () => {
    mocks.teams = [{ environmentId: "hub", team: team({ chat: { working: true } }) }];
    await render();
    expect(container.textContent).toContain("The group is working.");
    for (const name of ["New conversation", "Compact context", "Clear history"]) {
      expect(buttonNamed(name)?.disabled).toBe(true);
    }
  });

  it("holds the conversation actions without access", async () => {
    mocks.canConverse = false;
    await render();
    expect(buttonNamed("New conversation")?.disabled).toBe(true);
  });
});
