import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    projects: [] as unknown[],
    notesEnvironmentIds: [] as string[],
    navigate: vi.fn(),
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
vi.mock("../home/useThreadListActions", () => ({ useThreadListActions: () => ({}) }));
vi.mock("../home/threadArchive", () => ({ threadCanArchive: () => false }));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("./CustomSnoozeSheet", () => ({ CustomSnoozeSheet: () => null }));
vi.mock("./openThreadHandoff", () => ({ openThreadHandoff: vi.fn() }));
vi.mock("./thread-handoff", () => ({ canHandoffThread: () => false }));
vi.mock("./copyThreadMenuReference", () => ({ copyThreadMenuReference: vi.fn() }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));

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
function Probe() {
  seen(useThreadMenu(thread, vi.fn()).items);
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.navigate.mockReset();
  seen.mockReset();
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
