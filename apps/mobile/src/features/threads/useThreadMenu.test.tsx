import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    projects: [] as unknown[],
    notesEnvironmentIds: [] as string[],
    kanbanEnvironmentIds: [] as string[],
    linkedCard: null as unknown,
    canEditKanban: true,
    navigate: vi.fn(),
    stopSession: vi.fn(),
    refreshProviders: vi.fn(),
    alert: vi.fn(),
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    settlementEnvironmentIds: new Set(),
    snoozeEnvironmentIds: new Set(),
    snoozePresetsByEnvironmentId: new Map(),
    pinningEnvironmentIds: new Set(),
    autoSettleOptOutEnvironmentIds: new Set(),
    titleRegenerationEnvironmentIds: new Set(),
  }),
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "id" }));
vi.mock("../../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../../state/notes", () => ({ useNotesEnvironmentIds: () => mocks.notesEnvironmentIds }));
vi.mock("../../state/assistants", () => ({ useThreadAssistant: () => null }));
vi.mock("../../state/kanban", () => ({
  useKanbanEnvironmentIds: () => mocks.kanbanEnvironmentIds,
  useThreadKanbanCard: () => mocks.linkedCard,
}));
vi.mock("../kanban/useKanbanActions", () => ({
  useKanbanActions: () => ({ canEdit: mocks.canEditKanban }),
}));
vi.mock("../../state/presentation", () => ({ threadListEnvironmentsAtom: "atom" }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("./turnThreadIntoProject", () => ({
  turnThreadIntoProject: vi.fn(),
  canTurnThreadIntoProject: () => false,
}));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: { navigate: mocks.navigate },
  whenRootNavigationReady: (run: () => void) => run(),
}));
vi.mock("../assistants/useAssistantFlows", () => ({
  useAssistantFlows: () => ({ canAct: false, reset: vi.fn() }),
}));
vi.mock("../assistants/openAssistantEditor", () => ({ useOpenAssistantEditor: () => vi.fn() }));
vi.mock("../assistants/assistantWorkTarget", () => ({ useOpenAssistantWork: () => vi.fn() }));
vi.mock("../home/useThreadListActions", () => ({ useThreadListActions: () => ({}) }));
vi.mock("../home/threadArchive", () => ({ threadCanArchive: () => false }));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("./CustomSnoozeSheet", () => ({ CustomSnoozeSheet: () => null }));
vi.mock("./openThreadHandoff", () => ({ openThreadHandoff: vi.fn() }));
vi.mock("./thread-handoff", () => ({ canHandoffThread: () => false }));
vi.mock("./copyThreadMenuReference", () => ({ copyThreadMenuReference: vi.fn() }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { stopSession: "stopSession" } }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: "refreshProviders" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "stopSession" | "refreshProviders") => mocks[command],
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (result: { error: unknown }) => result.error,
}));

import { useThreadMenu } from "./useThreadMenu";

const thread = {
  environmentId: "env",
  id: "t1",
  projectId: "p1",
  branch: null,
  runtime: null,
  pinnedAt: null,
  autoSettleDisabledAt: null,
  titleRegeneration: null,
  settledOverride: null,
} as never;

let root: Root;
const seen = vi.fn<(items: AppBarMenuItem[] | null) => void>();
let probed: unknown = thread;
function Probe() {
  seen(useThreadMenu(probed as never, vi.fn()).items);
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.navigate.mockReset();
  seen.mockReset();
  mocks.alert.mockReset();
  mocks.stopSession.mockReset();
  mocks.refreshProviders.mockReset();
  probed = thread;
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

const mount = () => act(async () => root.render(<Probe />));
const notes = () => seen.mock.lastCall?.[0]?.find((item) => item.id === "notes");

describe("useThreadMenu Notes item", () => {
  it("opens Notes on the thread's project", async () => {
    mocks.notesEnvironmentIds = ["env"];
    mocks.projects = [{ environmentId: "env", id: "p1", title: "Alpha" }];
    await mount();
    const item = notes();
    expect(item).toBeDefined();
    act(() => (item as { onPress: () => void }).onPress());
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsNotes", {
      environmentId: "env",
      project: "p1",
    });
  });

  it("is absent where notes are unsupported or the thread has no real project", async () => {
    mocks.notesEnvironmentIds = [];
    mocks.projects = [{ environmentId: "env", id: "p1", title: "Alpha" }];
    await mount();
    expect(notes()).toBeUndefined();
    mocks.notesEnvironmentIds = ["env"];
    mocks.projects = [{ environmentId: "env", id: "p1", title: "Scratch", isScratch: true }];
    await mount();
    expect(notes()).toBeUndefined();
  });
});

describe("useThreadMenu Link to board card", () => {
  const linkCard = () => seen.mock.lastCall?.[0]?.find((item) => item.id === "link-card");

  it("opens the card picker on the thread's project board", async () => {
    mocks.kanbanEnvironmentIds = ["env"];
    mocks.linkedCard = null;
    mocks.canEditKanban = true;
    await mount();
    act(() => (linkCard() as { onPress: () => void }).onPress());
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsKanbanLinkCard", {
      environmentId: "env",
      threadId: "t1",
      projectId: "p1",
    });
  });

  it.each([
    { name: "a linked thread", linked: { id: "c1" }, envs: ["env"], canEdit: true },
    { name: "an environment without boards", linked: null, envs: [], canEdit: true },
    { name: "a read-only session", linked: null, envs: ["env"], canEdit: false },
  ])("is absent for $name", async ({ linked, envs, canEdit }) => {
    mocks.linkedCard = linked;
    mocks.kanbanEnvironmentIds = envs;
    mocks.canEditKanban = canEdit;
    await mount();
    expect(linkCard()).toBeUndefined();
  });
});

describe("useThreadMenu Restart agent session", () => {
  const press = async () => {
    const item = seen.mock.lastCall?.[0]?.find((entry) => entry.id === "restart-session");
    await act(async () => (item as { onPress: () => void }).onPress());
  };

  it("ends a live session, then reloads the provider fresh in the thread's checkout", async () => {
    mocks.projects = [{ environmentId: "env", id: "p1", workspaceRoot: "/repo" }];
    probed = {
      ...(thread as object),
      runtime: { providerInstanceId: "claude" },
      modelSelection: { instanceId: "codex" },
      worktreePath: "/repo/wt",
    };
    mocks.stopSession.mockResolvedValue({ _tag: "Success" });
    mocks.refreshProviders.mockResolvedValue({ _tag: "Success" });
    await mount();
    await press();
    expect(mocks.stopSession).toHaveBeenCalledWith({
      environmentId: "env",
      input: { threadId: "t1" },
    });
    expect(mocks.refreshProviders).toHaveBeenCalledWith({
      environmentId: "env",
      input: { instanceId: "claude", cwd: "/repo/wt", fresh: true },
    });
    expect(mocks.alert).toHaveBeenCalledWith(
      "Agent session will restart",
      "Your next message starts a fresh session.",
    );
  });

  it("skips stopping an idle thread and reports a failed reload", async () => {
    mocks.projects = [{ environmentId: "env", id: "p1", workspaceRoot: "/repo" }];
    probed = { ...(thread as object), modelSelection: { instanceId: "codex" }, worktreePath: null };
    mocks.refreshProviders.mockResolvedValue({ _tag: "Failure", error: new Error("offline") });
    await mount();
    await press();
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(mocks.refreshProviders).toHaveBeenCalledWith({
      environmentId: "env",
      input: { instanceId: "codex", cwd: "/repo", fresh: true },
    });
    expect(mocks.alert).toHaveBeenCalledWith("Could not restart the agent session", "offline");
  });

  it("stops at a failed session stop", async () => {
    mocks.projects = [];
    probed = { ...(thread as object), runtime: { providerInstanceId: "claude" } };
    mocks.stopSession.mockResolvedValue({ _tag: "Failure", error: "nope" });
    await mount();
    await press();
    expect(mocks.refreshProviders).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith("Could not restart the agent session", "Try again.");
  });
});
