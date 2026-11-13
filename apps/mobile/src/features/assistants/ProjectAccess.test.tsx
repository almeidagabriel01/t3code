import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    teams: [] as unknown[],
    active: [] as unknown[],
    teamUpdate: vi.fn(),
    update: vi.fn(),
    alert: vi.fn(),
    navigation: {},
    selectAllProjects: vi.fn(),
    toggleProject: vi.fn(),
    openSettings: vi.fn(),
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  Platform: { OS: "ios" },
  Keyboard: { dismiss: () => undefined },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => mocks.navigation }));
vi.mock("../settings/settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    projectGroups: [
      { key: "group-p1", members: [{ project: { environmentId: "env", id: "p1" } }] },
    ],
    selectAllProjects: mocks.selectAllProjects,
    toggleProject: mocks.toggleProject,
  }),
}));
vi.mock("../settings/settings-navigation", () => ({
  openSettings: (...args: unknown[]) => mocks.openSettings(...args),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./assistantPresentation", () => ({ AssistantAvatar: () => null }));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (...args: unknown[]) => mocks.alert(...args),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { title?: string; children?: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <>
      {props.label}
      <small>{props.description}</small>
    </>
  ),
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel: string;
    accessibilityState?: { checked?: boolean };
    disabled?: boolean;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-checked={props.accessibilityState?.checked}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/SearchField", () => ({
  SearchField: (props: { value: string; onChangeText: (value: string) => void }) => (
    <input
      aria-label="Search projects"
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { environmentId: "hub", id: "p1", title: "Café Alpha", workspaceRoot: "/a" },
    { environmentId: "hub", id: "p2", title: "Beta", workspaceRoot: "/b", archivedAt: "x" },
    { environmentId: "hub", id: "p3", title: "Gamma", workspaceRoot: "/c" },
    { environmentId: "other", id: "p9", title: "Elsewhere", workspaceRoot: "/e" },
  ],
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    active: mocks.active,
    teams: mocks.teams,
    activeTeams: mocks.teams,
  }),
  useAssistantTeamActions: () => ({ canAct: true, update: mocks.teamUpdate }),
  useAssistantActions: () => ({ canAct: true, update: mocks.update }),
}));

import { GroupProjectsSection } from "./GroupProjectsSection";
import { ProjectAssistantAccessSection } from "./ProjectAssistantAccessSection";
import { ProjectMultiPickerSection } from "./ProjectMultiPickerSection";
import { usePromptProjectAssistantAccess } from "./promptProjectAccess";

const team = (id: string, extra: object = {}) => ({
  id,
  name: id.toUpperCase(),
  memberIds: ["a1"],
  projectIds: [],
  archivedAt: null,
  ...extra,
});
const assistant = (id: string, extra: object = {}) => ({
  id,
  name: `Bot ${id}`,
  scope: "project",
  projectId: "p3",
  projectIds: ["p3"],
  archivedAt: null,
  ...extra,
});

let root: Root;
let container: HTMLDivElement;
const render = (node: ReactNode) => act(async () => root.render(node));
const row = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const press = (label: string) => act(async () => row(label).click());
const type = (value: string) =>
  act(async () => {
    const input = container.querySelector<HTMLInputElement>("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.teams = [];
  mocks.active = [];
  for (const fn of [mocks.teamUpdate, mocks.update, mocks.alert]) fn.mockReset();
  mocks.teamUpdate.mockResolvedValue({ ok: true, value: {} });
  mocks.update.mockResolvedValue({ ok: true, value: {} });
});
afterEach(() => act(() => root.unmount()));

describe("project multi picker", () => {
  const picker = (selected: string[], onChange = vi.fn()) => (
    <ProjectMultiPickerSection
      environmentId={"hub" as never}
      selected={selected as never}
      onChange={onChange}
    />
  );

  it("lists this environment's projects, marks archived ones and toggles", async () => {
    const onChange = vi.fn();
    await render(picker(["p1"], onChange));
    expect(container.textContent).toContain("Archived");
    expect(container.textContent).not.toContain("Elsewhere");
    expect(row("Café Alpha").getAttribute("aria-checked")).toBe("true");
    await press("Gamma");
    expect(onChange).toHaveBeenLastCalledWith(["p1", "p3"]);
    await press("Café Alpha");
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("searches without case or accents and says when nothing matches", async () => {
    await render(picker([]));
    await type("CAFE");
    expect(container.querySelector('[aria-label="Café Alpha"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Beta"]')).toBeNull();
    await type("zzz");
    expect(container.textContent).toContain("No projects match");
  });
});

describe("group projects", () => {
  it("counts the members that would gain access", async () => {
    mocks.active = [{ environmentId: "hub", assistant: assistant("a1", { projectIds: ["p3"] }) }];
    const group = team("g1");
    mocks.teams = [{ environmentId: "hub", team: group }];
    const section = (value: string[]) => (
      <GroupProjectsSection
        environmentId={"hub" as never}
        team={group as never}
        value={value as never}
        onChange={vi.fn()}
      />
    );
    await render(section([]));
    expect(container.textContent).not.toContain("gain access");
    await render(section(["p1"]));
    expect(container.textContent).toContain("1 member gains access");
    await render(section(["p3"]));
    expect(container.textContent).not.toContain("gain access");
  });
});

describe("assistants with access", () => {
  const access = () => (
    <ProjectAssistantAccessSection environmentId={"hub" as never} projectId={"p1" as never} />
  );

  it("toggles a group with add and remove", async () => {
    mocks.teams = [
      { environmentId: "hub", team: team("g1") },
      { environmentId: "hub", team: team("g2", { projectIds: ["p1"] }) },
    ];
    await render(access());
    await press("G1");
    expect(mocks.teamUpdate).toHaveBeenLastCalledWith({ teamId: "g1", addProjectIds: ["p1"] });
    await press("G2");
    expect(mocks.teamUpdate).toHaveBeenLastCalledWith({ teamId: "g2", removeProjectIds: ["p1"] });
  });

  it("turns off assistants it cannot change and says why", async () => {
    mocks.teams = [{ environmentId: "hub", team: team("g1", { projectIds: ["p1"] }) }];
    mocks.active = [
      { environmentId: "hub", assistant: assistant("a1") },
      { environmentId: "hub", assistant: assistant("a2", { scope: "all" }) },
      {
        environmentId: "hub",
        assistant: assistant("a3", { projectId: "p1", projectIds: ["p1"] }),
      },
    ];
    await render(access());
    expect(row("Bot a1").disabled).toBe(true);
    expect(container.textContent).toContain("Via G1");
    expect(row("Bot a2").disabled).toBe(true);
    expect(container.textContent).toContain("All projects");
    expect(row("Bot a3").disabled).toBe(true);
    expect(container.textContent).toContain("Home project");
  });

  it("adds and removes the project on an assistant's own list, and shows a refusal", async () => {
    mocks.active = [
      { environmentId: "hub", assistant: assistant("a1") },
      { environmentId: "hub", assistant: assistant("a4", { projectIds: ["p3", "p1"] }) },
    ];
    await render(access());
    await press("Bot a1");
    expect(mocks.update).toHaveBeenLastCalledWith({ assistantId: "a1", projectIds: ["p3", "p1"] });
    await press("Bot a4");
    expect(mocks.update).toHaveBeenLastCalledWith({ assistantId: "a4", projectIds: ["p3"] });
    mocks.update.mockResolvedValue({ ok: false, message: "Nope." });
    await press("Bot a1");
    expect(mocks.alert).toHaveBeenCalledWith("Could not update Bot a1", "Nope.");
  });
});

describe("access prompt after adding a project", () => {
  it("asks only where an assistant could use the project, then opens its settings", async () => {
    mocks.teams = [{ environmentId: "env", team: team("t1") }];
    mocks.active = [];
    mocks.alert.mockClear();
    const Ask = (props: {
      readonly env: string;
      readonly project: string;
      readonly title: string;
    }) => {
      const prompt = usePromptProjectAssistantAccess();
      return (
        <button
          aria-label={`ask ${props.title}`}
          onClick={() => prompt(props.env as never, props.project as never, props.title)}
        />
      );
    };
    await render(
      <>
        <Ask env="other" project="p9" title="Elsewhere" />
        <Ask env="env" project="p404" title="Unknown" />
        <Ask env="env" project="p1" title="Shop" />
      </>,
    );
    await press("ask Elsewhere");
    await press("ask Unknown");
    expect(mocks.alert).not.toHaveBeenCalled();
    await press("ask Shop");
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    const [title, , buttons] = mocks.alert.mock.calls[0]! as [
      string,
      string,
      Array<{ text: string; onPress?: () => void }>,
    ];
    expect(title).toBe("Let assistants work in Shop?");
    buttons.find((button) => button.text === "Choose assistants")!.onPress!();
    expect(mocks.selectAllProjects).toHaveBeenCalled();
    expect(mocks.toggleProject).toHaveBeenCalledWith("group-p1");
    expect(mocks.openSettings).toHaveBeenCalledWith(mocks.navigation, "SettingsProjectOverview");
  });
});
