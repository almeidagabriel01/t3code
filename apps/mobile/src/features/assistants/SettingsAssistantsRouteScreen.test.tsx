import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    budgetState: undefined as undefined | "ok" | "warn" | "exceeded",
    environmentIds: ["hub"] as string[],
    spendQuery: vi.fn(),
    openEditor: vi.fn(),
    restoreDefault: vi.fn(),
    hasDefault: true,
    openTeam: { edit: vi.fn(), activity: vi.fn() },
  },
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; onPress: () => void }) => (
    <button aria-label={props.label} onClick={props.onPress} />
  ),
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({ canAct: true, restoreDefault: mocks.restoreDefault }),
}));
vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: { accessibilityLabel?: string; onPress?: () => void }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress} />
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel: string;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: () => null,
  toolAccessLabel: () => "Full access",
}));
vi.mock("./AutonomySettingsSection", () => ({
  AutonomySettingsSection: (props: { environmentId: string; suffix: string }) => (
    <p data-autonomy>{`Autonomy:${props.environmentId}${props.suffix}`}</p>
  ),
}));
vi.mock("./assistantTeamTarget", () => ({ useOpenAssistantTeam: () => mocks.openTeam }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./openAssistantEditor", () => ({ useOpenAssistantEditor: () => mocks.openEditor }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({
    savedConnectionsById: { lab: { environmentLabel: "Lab" } },
  }),
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    environmentIds: mocks.environmentIds,
    active: [
      {
        environmentId: "hub",
        assistant: {
          id: "a1",
          name: "Jarvis",
          isDefault: mocks.hasDefault,
          handle: "jarvis",
          budget: {},
          role: "CEO",
          reportsTo: null,
        },
      },
      {
        environmentId: "hub",
        assistant: {
          id: "a2",
          name: "Plain",
          handle: "plain",
          budget: null,
          role: "",
          reportsTo: "a1",
        },
      },
    ],
    archived: [],
    teams: [
      {
        environmentId: "hub",
        team: {
          id: "t1",
          name: "Growth",
          memberIds: ["a1", "a2"],
          leaderId: "a1",
          leaderTitle: "CEO",
        },
      },
    ],
  }),
  useAssistantsEnvironmentIds: () => mocks.environmentIds,
  useAssistantSpend: (environmentId: string, assistantId: string | null) => {
    mocks.spendQuery(environmentId, assistantId);
    return { data: assistantId ? { budget: { state: mocks.budgetState } } : null };
  },
}));

import { SettingsAssistantsRouteScreen } from "./SettingsAssistantsRouteScreen";

let root: Root;
let container: HTMLDivElement;
const labelOf = (name: string) =>
  Array.from(container.querySelectorAll("button"))
    .map((entry) => entry.getAttribute("aria-label") ?? "")
    .find((label) => label.startsWith(`${name},`));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.spendQuery.mockReset();
  mocks.openEditor.mockReset();
  mocks.environmentIds = ["hub"];
  mocks.hasDefault = true;
  mocks.restoreDefault.mockReset();
  mocks.openTeam.edit.mockReset();
  mocks.openTeam.activity.mockReset();
});
afterEach(() => act(() => root.unmount()));

describe("assistant list budget state", () => {
  it.each([
    ["exceeded", ", Limit reached"],
    ["warn", ", Near limit"],
    ["ok", ""],
  ] as const)("a %s limit reads %j on the row", (state, suffix) => {
    mocks.budgetState = state;
    act(() => root.render(<SettingsAssistantsRouteScreen />));
    const label = labelOf("Jarvis")!;
    expect(label).toBe(`Jarvis, @jarvis, CEO, Full access${suffix}`);
    expect(labelOf("Plain")).toBe("Plain, @plain, reports to Jarvis, Full access");
    expect(mocks.spendQuery).toHaveBeenCalledWith("hub", "a1");
    expect(mocks.spendQuery).toHaveBeenCalledWith("hub", null);
  });
});

describe("assistant list autonomy", () => {
  it("shows one Autonomy section per server, named only when there are several", () => {
    act(() => root.render(<SettingsAssistantsRouteScreen />));
    expect(
      Array.from(container.querySelectorAll("[data-autonomy]")).map((n) => n.textContent),
    ).toEqual(["Autonomy:hub"]);
    mocks.environmentIds = ["hub", "lab"];
    act(() => root.render(<SettingsAssistantsRouteScreen key="two" />));
    expect(
      Array.from(container.querySelectorAll("[data-autonomy]")).map((n) => n.textContent),
    ).toEqual(["Autonomy:hub · hub", "Autonomy:lab · Lab"]);
  });
});

describe("restoring Jarvis", () => {
  it("offers Restore Jarvis only while no assistant is the default", () => {
    act(() => root.render(<SettingsAssistantsRouteScreen />));
    expect(container.querySelector('[aria-label="Restore Jarvis"]')).toBeNull();
    mocks.hasDefault = false;
    act(() => root.render(<SettingsAssistantsRouteScreen key="gone" />));
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Restore Jarvis"]')!;
    act(() => button.click());
    expect(mocks.restoreDefault).toHaveBeenCalledOnce();
  });
});

describe("teams section", () => {
  it("lists teams with their leader title, opens the activity or the form, and offers a new team", async () => {
    await act(async () => root.render(<SettingsAssistantsRouteScreen />));
    const click = (label: string) =>
      act(async () =>
        container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click(),
      );
    await click("Growth, 2 members · Jarvis (CEO)");
    expect(mocks.openTeam.activity).toHaveBeenCalledWith("hub", "t1");
    await click("Edit Growth");
    expect(mocks.openTeam.edit).toHaveBeenCalledWith("hub", "t1");
    await click("New team");
    expect(mocks.openTeam.edit).toHaveBeenLastCalledWith("hub", null);
  });
});
