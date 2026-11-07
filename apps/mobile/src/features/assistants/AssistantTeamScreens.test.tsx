import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    target: null as null | { environmentId: string; teamId: string | null },
    teams: [] as unknown[],
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    goBack: vi.fn(),
    open: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
  },
}));
const assistants = ["ana", "bob", "cy"].map((id) => ({
  environmentId: "hub",
  assistant: { id, name: id.toUpperCase(), handle: id, icon: null, archivedAt: null },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.target }));
vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: {
    accessibilityLabel?: string;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  TextInput: (props: {
    accessibilityLabel?: string;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: mocks.goBack }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: { markdown: string }) => props.markdown,
}));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
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
  alert: (...args: unknown[]) => mocks.alert(...args),
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string }) => <p>{props.title}</p>,
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./AssistantFormFields", () => ({
  ChoiceRow: (props: { label: string; selected: boolean; onPress: () => void }) => (
    <button aria-label={props.label} aria-checked={props.selected} onClick={props.onPress} />
  ),
  FieldHeader: () => null,
  TextField: (props: { label: string; value: string; onChange: (value: string) => void }) => (
    <input
      aria-label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));
vi.mock("./assistantPresentation", () => ({ AssistantAvatar: () => null }));
vi.mock("./assistantTeamTarget", () => ({ assistantTeamTargetAtom: {} }));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({ openConversation: mocks.open }),
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: assistants, archived: [], teams: mocks.teams }),
  useAssistantTeamActions: () => ({
    canAct: true,
    create: mocks.create,
    update: mocks.update,
    remove: mocks.remove,
  }),
}));

import { AssistantTeamEditRouteScreen } from "./AssistantTeamEditRouteScreen";

const team = {
  id: "t1",
  name: "Growth",
  memberIds: ["ana", "bob"],
  leadId: "bob",
};

let root: Root;
let container: HTMLDivElement;
const el = (label: string) =>
  container.querySelector<HTMLButtonElement & HTMLInputElement>(`[aria-label="${label}"]`);
const click = (label: string) => act(async () => el(label)?.click());
const text = (label: string, value: string) =>
  act(async () => {
    const input = el(label)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const buttonNamed = (name: string) =>
  Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === name);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.target = { environmentId: "hub", teamId: null };
  mocks.teams = [{ environmentId: "hub", team }];
  for (const fn of [
    mocks.create,
    mocks.update,
    mocks.remove,
    mocks.goBack,
    mocks.open,
    mocks.alert,
  ])
    fn.mockReset();
  mocks.create.mockResolvedValue({ ok: true, value: {} });
  mocks.update.mockResolvedValue({ ok: true, value: {} });
  mocks.remove.mockResolvedValue({ ok: true, value: {} });
});
afterEach(() => act(() => root.unmount()));

describe("team form", () => {
  it("asks to open a team first when nothing was chosen", async () => {
    mocks.target = null;
    await act(async () => root.render(<AssistantTeamEditRouteScreen />));
    expect(container.textContent).toContain("Open a group first.");
  });

  it("creates a group with no members or one", async () => {
    await act(async () => root.render(<AssistantTeamEditRouteScreen />));
    expect(buttonNamed("Create group")?.disabled).toBe(true);
    await text("Name", "Money");
    expect(buttonNamed("Create group")?.disabled).toBe(false);
    await act(async () => buttonNamed("Create group")?.click());
    expect(mocks.create).toHaveBeenLastCalledWith({
      name: "Money",
      memberIds: [],
      leadId: null,
    });
    await click("ANA");
    expect(buttonNamed("Create group")?.disabled).toBe(false);
    await click("BOB");
    // The lead list repeats the members: the second BOB row is the radio.
    const bobRows = container.querySelectorAll<HTMLButtonElement>('[aria-label="BOB"]');
    await act(async () => bobRows[1]?.click());
    await act(async () => buttonNamed("Create group")?.click());
    expect(mocks.create).toHaveBeenCalledWith({
      name: "Money",
      memberIds: ["ana", "bob"],
      leadId: "bob",
    });
    expect(mocks.goBack).toHaveBeenCalled();
  });

  it("a refused save stays on the form and says why", async () => {
    mocks.create.mockResolvedValue({ ok: false, message: "Nope." });
    mocks.target = { environmentId: "hub", teamId: null };
    await act(async () => root.render(<AssistantTeamEditRouteScreen />));
    await text("Name", "X");
    await click("ANA");
    await click("CY");
    await act(async () => buttonNamed("Create group")?.click());
    expect(container.textContent).toContain("Nope.");
    expect(mocks.goBack).not.toHaveBeenCalled();
  });

  it("edits a team, dropping the lead clears it, and delete asks first", async () => {
    mocks.target = { environmentId: "hub", teamId: "t1" };
    await act(async () => root.render(<AssistantTeamEditRouteScreen />));
    await click("Nobody");
    await act(async () => buttonNamed("Save")?.click());
    expect(mocks.update).toHaveBeenCalledWith({
      teamId: "t1",
      name: "Growth",
      memberIds: ["ana", "bob"],
      leadId: null,
    });
    await act(async () => buttonNamed("Delete group")?.click());
    expect(mocks.confirm).toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith("t1");
    mocks.remove.mockResolvedValue({ ok: false, message: "Gone wrong" });
    await act(async () => buttonNamed("Delete group")?.click());
    expect(mocks.alert).toHaveBeenCalledWith("Could not delete the group", "Gone wrong");
  });
});
