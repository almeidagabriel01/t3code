import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Presence = { mood: string; detail: string; since: string | null; queued?: number };

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    budgetState: undefined as undefined | "ok" | "warn" | "exceeded",
    environmentIds: ["hub"] as string[],
    spendQuery: vi.fn(),
    openEditor: vi.fn(),
    openWork: vi.fn(),
    restoreDefault: vi.fn(),
    unarchive: vi.fn(),
    archive: vi.fn(),
    open: vi.fn(),
    hasDefault: true,
    presence: {} as Record<string, Presence>,
    entries: null as null | { active: unknown[]; archived: unknown[]; teams: unknown[] },
    openTeam: { edit: vi.fn(), chat: vi.fn() },
    archivedTeams: [] as unknown[],
    archiveTeam: vi.fn(),
    restoreTeam: vi.fn(),
  },
}));
const assistant = (id: string, name: string, extra: object = {}) => ({
  environmentId: "hub",
  assistant: {
    id,
    name,
    isDefault: false,
    handle: id,
    budget: null,
    role: "",
    scope: "all",
    projectId: "p0",
    threadId: `t-${id}`,
    archivedAt: null,
    ...extra,
  },
});
const defaults = () => ({
  active: [
    assistant("a1", "Jarvis", { isDefault: mocks.hasDefault, budget: {}, role: "CEO" }),
    assistant("a2", "Plain"),
  ],
  archived: [] as unknown[],
  teams: [
    {
      environmentId: "hub",
      team: {
        id: "g1",
        name: "Growth",
        memberIds: ["a1", "a2"],
        leadId: "a1",
      },
    },
  ],
});
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; onPress: () => void }) => (
    <button aria-label={props.label} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({
    canAct: true,
    restoreDefault: mocks.restoreDefault,
    unarchive: mocks.unarchive,
    archive: mocks.archive,
    openConversation: mocks.open,
  }),
  useAssistantTeamFlows: () => ({
    canAct: true,
    archive: mocks.archiveTeam,
    restore: mocks.restoreTeam,
  }),
}));
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode; accessibilityLabel?: string }) => (
    <div aria-label={props.accessibilityLabel}>{props.children}</div>
  ),
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
vi.mock("@t3tools/client-runtime/assistantRobot", () => ({
  assistantGroupThreadsOf: () => [],
  assistantGroupOwnerKey: () => undefined,
  assistantFace: (presence: { mood: string }) =>
    presence.mood === "needs" ? "waiting" : presence.mood,
  assistantQueuedLabel: (queued: number | undefined) =>
    queued !== undefined && queued > 0 ? `${queued} queued` : null,
  assistantPresence: (thread: { id: string } | null): Presence =>
    thread === null
      ? { mood: "idle", detail: "Idle", since: null }
      : (mocks.presence[thread.id] ?? { mood: "idle", detail: "Idle", since: null }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string }) => <p>{props.title}</p>,
}));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: Array<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          aria-label={`menu:${action.title}`}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </>
  ),
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => Date.parse("2026-11-06T12:00:00Z") }));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: {
    actions?: Array<{ accessibilityLabel: string; onPress: () => void }>;
    children?: ReactNode;
  }) => (
    <>
      {props.actions?.map((action) => (
        <button
          key={action.accessibilityLabel}
          aria-label={action.accessibilityLabel}
          onClick={action.onPress}
        />
      ))}
      {props.children}
    </>
  ),
}));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { mood?: string }) => <i>{`av:${props.mood}`}</i>,
}));
vi.mock("./AutonomySettingsSection", () => ({
  AutonomySettingsSection: (props: { environmentId: string; suffix: string }) => (
    <p data-autonomy>{`Autonomy:${props.environmentId}${props.suffix}`}</p>
  ),
}));
vi.mock("./AssistantSandboxSection", () => ({
  AssistantSandboxSection: (props: { environmentId: string; suffix: string }) => (
    <p data-sandbox>{`Sandbox:${props.environmentId}${props.suffix}`}</p>
  ),
}));
vi.mock("./assistantTeamTarget", () => ({ useOpenAssistantTeam: () => mocks.openTeam }));
vi.mock("./assistantWorkTarget", () => ({ useOpenAssistantWork: () => mocks.openWork }));
vi.mock("./openAssistantEditor", () => ({ useOpenAssistantEditor: () => mocks.openEditor }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "hub", id: "p1", title: "Website" }],
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : { id: ref.threadId },
  useQuietThreadShells: () =>
    (mocks.entries ?? defaults()).active.map((entry) => ({
      environmentId: "hub",
      id: (entry as ReturnType<typeof assistant>).assistant.threadId,
    })),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({
    savedConnectionsById: { lab: { environmentLabel: "Lab" }, hub: { environmentLabel: "Hub" } },
  }),
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => {
    const entries = mocks.entries ?? defaults();
    return {
      environmentIds: mocks.environmentIds,
      ...entries,
      activeTeams: entries.teams,
      archivedTeams: mocks.archivedTeams,
    };
  },
  useAssistantsEnvironmentIds: () => mocks.environmentIds,
  useAssistantTasks: () => [],
  useAssistantSpend: (environmentId: string, assistantId: string | null) => {
    mocks.spendQuery(environmentId, assistantId);
    return { data: assistantId ? { budget: { state: mocks.budgetState } } : null };
  },
}));

import { SettingsAssistantsRouteScreen } from "./SettingsAssistantsRouteScreen";

let root: Root;
let container: HTMLDivElement;
const render = (key = "x") => act(() => root.render(<SettingsAssistantsRouteScreen key={key} />));
const byLabel = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const click = (label: string) => act(async () => byLabel(label)?.click());
const buttonIn = (card: string, name: string) =>
  Array.from(byLabel(card)!.querySelectorAll("button")).find((b) => b.textContent === name)!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.entries = null;
  mocks.archivedTeams = [];
  mocks.budgetState = undefined;
  mocks.presence = {};
  mocks.environmentIds = ["hub"];
  mocks.hasDefault = true;
  for (const fn of [
    mocks.spendQuery,
    mocks.openEditor,
    mocks.openWork,
    mocks.restoreDefault,
    mocks.unarchive,
    mocks.archive,
    mocks.open,
    mocks.openTeam.edit,
  ]) {
    fn.mockReset();
  }
});
afterEach(() => act(() => root.unmount()));

describe("assistants page", () => {
  it.each([
    ["exceeded", ", Limit reached"],
    ["warn", ", Near limit"],
    ["ok", ""],
  ] as const)("a %s limit reads %j on the card", (state, suffix) => {
    mocks.budgetState = state;
    render();
    expect(byLabel(`Jarvis, All projects${suffix}`)).not.toBeNull();
    expect(byLabel("Plain, All projects")).not.toBeNull();
    expect(mocks.spendQuery).toHaveBeenCalledWith("hub", "a1");
    expect(mocks.spendQuery).toHaveBeenCalledWith("hub", null);
  });

  it("splits the cards into Needs you, groups, projects, Unassigned and Archived", () => {
    mocks.entries = {
      active: [
        assistant("a1", "Jarvis"),
        assistant("a2", "Scout", { scope: "project", projectId: "p1" }),
        assistant("a3", "Loose"),
        assistant("a4", "Asker"),
      ],
      archived: [assistant("a5", "Old", { archivedAt: "2026-01-01T00:00:00Z" })],
      teams: [
        { environmentId: "hub", team: { id: "g1", name: "Growth", memberIds: ["a1"] } },
        { environmentId: "hub", team: { id: "g2", name: "Empty", memberIds: [] } },
      ],
    };
    mocks.presence["t-a4"] = { mood: "needs", detail: "Needs your approval", since: null };
    render();
    const text = container.textContent ?? "";
    const order = ["Needs you", "Growth", "Empty", "Website", "Unassigned", "Archived"].map(
      (title) => text.indexOf(title),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain("No members yet.");
    expect(byLabel("Scout, Website")).not.toBeNull();
    expect(text).toContain("Needs your approval");
    // A member card names its groups; an unassigned one has none.
    expect(byLabel("Jarvis, All projects")?.textContent).toContain("Growth");
    expect(byLabel("Loose, All projects")?.textContent).not.toContain("Growth");
  });

  it("shows the status with its relative time, and archived cards as Archived and idle", () => {
    mocks.entries = {
      ...defaults(),
      archived: [assistant("a9", "Old", { archivedAt: "2026-01-01T00:00:00Z" })],
    };
    mocks.presence["t-a1"] = {
      mood: "working",
      detail: "Reading",
      since: "2026-11-06T11:55:00Z",
      queued: 2,
    };
    mocks.presence["t-a9"] = { mood: "working", detail: "Reading", since: null };
    render();
    expect(container.textContent).toContain("Reading · 5m · 2 queued");
    expect(byLabel("Old, All projects")?.textContent).toContain("Archived");
    expect(byLabel("Old, All projects")?.textContent).toContain("av:sleeping");
    expect(byLabel("Jarvis, All projects")?.textContent).toContain("av:working");
  });

  it("a card opens its thread, edits, and archives; an archived one restores", async () => {
    mocks.entries = {
      ...defaults(),
      archived: [assistant("a9", "Old", { archivedAt: "2026-01-01T00:00:00Z" })],
    };
    render();
    act(() => buttonIn("Jarvis, All projects", "Open thread").click());
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    act(() => buttonIn("Jarvis, All projects", "Edit").click());
    expect(mocks.openEditor).toHaveBeenCalledWith("hub", expect.objectContaining({ id: "a1" }));
    act(() => buttonIn("Jarvis, All projects", "Work").click());
    expect(mocks.openWork).toHaveBeenCalledWith("hub", "a1");
    act(() => buttonIn("Jarvis, All projects", "Archive").click());
    expect(mocks.archive).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    expect(byLabel("Old, All projects")?.textContent).not.toContain("Open thread");
    act(() => buttonIn("Old, All projects", "Restore").click());
    expect(mocks.unarchive).toHaveBeenCalledWith(expect.objectContaining({ id: "a9" }));
  });

  it("cannot open the thread of an assistant that has none", () => {
    mocks.entries = {
      ...defaults(),
      active: [assistant("a1", "Fresh", { threadId: null, isDefault: true })],
    };
    render();
    expect(buttonIn("Fresh, All projects", "Open thread").disabled).toBe(true);
  });

  it("each group and project starts an assistant in itself; a group also edits", async () => {
    mocks.entries = {
      active: [assistant("a1", "Scout", { scope: "project", projectId: "p1", isDefault: true })],
      archived: [],
      teams: [{ environmentId: "hub", team: { id: "g1", name: "Growth", memberIds: [] } }],
    };
    render();
    await click("menu:New assistant in this group");
    expect(mocks.openEditor).toHaveBeenCalledWith("hub", null, { teamId: "g1" });
    await click("menu:Edit group");
    expect(mocks.openTeam.edit).toHaveBeenCalledWith("hub", "g1");
    await click("menu:Open chat");
    expect(mocks.openTeam.chat).toHaveBeenCalledWith("hub", "g1");
    await click("menu:Archive group");
    expect(mocks.archiveTeam).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    await click("menu:New assistant in this project");
    expect(mocks.openEditor).toHaveBeenLastCalledWith("hub", null, { projectId: "p1" });
  });

  it("archived groups are listed apart and restore from their row", async () => {
    mocks.archivedTeams = [
      { environmentId: "hub", team: { id: "g9", name: "Old crew", memberIds: ["a1", "a2"] } },
    ];
    render();
    expect(container.textContent).toContain("Archived groups");
    expect(container.textContent).toContain("2 members");
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Restore")
        ?.click(),
    );
    expect(mocks.restoreTeam).toHaveBeenCalledWith(expect.objectContaining({ id: "g9" }));
  });

  it("the header creates an assistant or a group", async () => {
    render();
    await click("New assistant");
    expect(mocks.openEditor).toHaveBeenCalledWith("hub", null);
    await click("New group");
    expect(mocks.openTeam.edit).toHaveBeenCalledWith("hub", null);
  });

  it("says so when no server has assistants, and when there are none yet", () => {
    mocks.environmentIds = [];
    render("none");
    expect(container.textContent).toContain("No assistants");
    expect(byLabel("New assistant")).toBeNull();
    mocks.environmentIds = ["hub"];
    mocks.entries = { active: [], archived: [], teams: [] };
    render("empty");
    expect(container.textContent).toContain("No assistants yet");
    expect(byLabel("Restore Jarvis")).not.toBeNull();
  });

  it("names the server on a card only when there are several", () => {
    mocks.environmentIds = ["hub", "lab"];
    render("two");
    expect(byLabel("Plain, All projects, Hub")).not.toBeNull();
  });
});

describe("assistant settings below the cards", () => {
  it("shows one Autonomy and Sandbox section per server, named only when there are several", () => {
    render();
    expect(
      Array.from(container.querySelectorAll("[data-autonomy]")).map((n) => n.textContent),
    ).toEqual(["Autonomy:hub"]);
    expect(
      Array.from(container.querySelectorAll("[data-sandbox]")).map((n) => n.textContent),
    ).toEqual(["Sandbox:hub"]);
    mocks.environmentIds = ["hub", "lab"];
    render("two");
    expect(
      Array.from(container.querySelectorAll("[data-autonomy]")).map((n) => n.textContent),
    ).toEqual(["Autonomy:hub · Hub", "Autonomy:lab · Lab"]);
    expect(
      Array.from(container.querySelectorAll("[data-sandbox]")).map((n) => n.textContent),
    ).toEqual(["Sandbox:hub · Hub", "Sandbox:lab · Lab"]);
  });

  it("offers Restore Jarvis only while no assistant is the default", () => {
    render();
    expect(byLabel("Restore Jarvis")).toBeNull();
    mocks.hasDefault = false;
    render("gone");
    act(() => byLabel("Restore Jarvis")!.click());
    expect(mocks.restoreDefault).toHaveBeenCalledOnce();
  });
});
