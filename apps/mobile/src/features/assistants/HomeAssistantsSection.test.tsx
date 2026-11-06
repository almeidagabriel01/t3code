import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    open: vi.fn(),
    editor: vi.fn(),
    toggle: vi.fn(),
    openTeam: vi.fn(),
    teams: [] as Array<{
      environmentId: string;
      team: { id: string; name: string; memberIds: string[] };
    }>,
    collapsed: false,
    status: "idle" as "idle" | "working" | "attention",
    active: [] as Array<{
      environmentId: string;
      assistant: { id: string; name: string; handle: string; threadId: string | null };
    }>,
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: {
    onPress?: () => void;
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/client-runtime/state/thread-attention", () => ({
  resolveSidebarThreadStatus: () => (mocks.status === "working" ? "working" : "idle"),
  hasSidebarNotification: () => mocks.status === "attention",
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <b>spinner</b>,
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: (props: { name: string }) => <s>{`symbol:${props.name}`}</s>,
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../state/entities", () => ({ useQuietThreadShell: () => ({ lastVisitedAt: "x" }) }));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: mocks.active, teams: mocks.teams }),
}));
vi.mock("../threads/SubagentStatusDot", () => ({
  SubagentStatusDot: (props: { tone: string }) => <u>{`dot:${props.tone}`}</u>,
}));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { assistant: { name: string } }) => (
    <i>{`av:${props.assistant.name}`}</i>
  ),
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({ canAct: true, openConversation: mocks.open }),
}));
vi.mock("./assistantTeamTarget", () => ({
  useOpenAssistantTeam: () => ({ activity: mocks.openTeam }),
}));
vi.mock("./openAssistantEditor", () => ({ useOpenAssistantEditor: () => mocks.editor }));
vi.mock("../home/useHomeSectionPreferences", () => ({
  useHomeSectionPreferences: () => ({
    assistantsCollapsed: mocks.collapsed,
    toggleAssistants: mocks.toggle,
  }),
}));

import { HomeAssistantsSection } from "./HomeAssistantsSection";

const make = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    environmentId: "hub",
    assistant: { id: `a${i}`, name: `Bot${i}`, handle: `bot${i}`, threadId: `t${i}` },
  }));

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(() =>
    root.render(<HomeAssistantsSection gutter={4} sidebar environmentLabelById={new Map()} />),
  );
const byLabel = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  Object.assign(mocks, { collapsed: false, status: "idle", active: make(2) });
  mocks.open.mockReset();
  mocks.toggle.mockReset();
  mocks.editor.mockReset();
  mocks.openTeam.mockReset();
  mocks.teams = [];
});
afterEach(() => act(() => root.unmount()));

describe("HomeAssistantsSection", () => {
  it("renders nothing without assistants", () => {
    mocks.active = [];
    render();
    expect(container.textContent).toBe("");
  });

  it("expanded: shows the rows, a down chevron, and toggles from the header", async () => {
    render();
    expect(container.textContent).toContain("symbol:chevron.down");
    expect(byLabel("Bot0")).not.toBeNull();
    await act(async () => byLabel("Assistants")?.click());
    expect(mocks.toggle).toHaveBeenCalledOnce();
    await act(async () => byLabel("New assistant")?.click());
    expect(mocks.editor).toHaveBeenCalledWith("hub", null);
  });

  it("collapsed: shows five avatars then +N, and an avatar opens its conversation", async () => {
    mocks.collapsed = true;
    mocks.active = make(7);
    render();
    expect(container.textContent).toContain("symbol:chevron.right");
    expect(container.textContent).toContain("+2");
    expect(byLabel("Bot4")).not.toBeNull();
    expect(byLabel("Bot5")).toBeNull();
    await act(async () => byLabel("Bot1")?.click());
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    await act(async () => byLabel("2 more assistants")?.click());
    expect(mocks.toggle).toHaveBeenCalledOnce();
    expect(byLabel("New assistant")).not.toBeNull();
  });

  it.each([
    ["working", "Bot0, working", "dot:working"],
    ["attention", "Bot0, needs attention", "dot:completed"],
  ] as const)("collapsed avatar shows %s state", (status, label, dot) => {
    mocks.collapsed = true;
    mocks.active = make(1);
    mocks.status = status;
    render();
    expect(byLabel(label)?.textContent).toContain(dot);
  });

  it("expanded rows show the working spinner and attention dot", () => {
    mocks.status = "working";
    render();
    expect(container.textContent).toContain("spinner");
    mocks.status = "attention";
    render();
    expect(container.textContent).toContain("dot:completed");
  });

  it("lists teams under the assistants, hides them when collapsed, and opens the activity", async () => {
    mocks.teams = [
      { environmentId: "hub", team: { id: "t1", name: "Growth", memberIds: ["a0", "a1"] } },
    ];
    render();
    await act(async () => byLabel("Growth team, 2 members")?.click());
    expect(mocks.openTeam).toHaveBeenCalledWith("hub", "t1");
    mocks.collapsed = true;
    render();
    expect(byLabel("Growth team, 2 members")).toBeNull();
  });
});
