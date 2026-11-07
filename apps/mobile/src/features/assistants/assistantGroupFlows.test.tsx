import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    update: vi.fn(),
    alert: vi.fn(),
    navigate: vi.fn(),
    startEditor: vi.fn(),
    draftFor: vi.fn(),
    set: vi.fn(),
    targets: [{ environmentId: "hub", label: "Hub" }] as Array<{
      environmentId: string;
      label: string;
    }>,
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../components/ui/Dialog", () => ({
  confirm: (request: { onConfirm: () => void }) => request.onConfirm(),
  alert: (...args: unknown[]) => mocks.alert(...args),
}));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { set: mocks.set } }));
vi.mock("../../state/assistants", () => ({
  useAssistantActions: () => ({ canAct: true }),
  useAssistantTeamActions: () => ({ canAct: true, update: mocks.update }),
}));
vi.mock("../settings/scheduled-task-editor", () => ({
  useScheduledTaskEditor: () => ({
    draftForEnvironment: mocks.draftFor,
    startEditor: mocks.startEditor,
  }),
}));
vi.mock("../settings/settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({ availableTargets: mocks.targets }),
}));

import { useOpenAssistantTeam } from "./assistantTeamTarget";
import { useAssistantTeamFlows } from "./useAssistantFlows";
import { useScheduleInGroup } from "./useScheduleInGroup";

let root: Root;
const run = <T,>(hook: () => T): T => {
  let value!: T;
  const Probe = () => {
    value = hook();
    return null;
  };
  act(() => root.render(<Probe />));
  return value;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(window.document.createElement("div"));
  for (const fn of [mocks.update, mocks.alert, mocks.navigate, mocks.startEditor, mocks.set])
    fn.mockReset();
  mocks.update.mockResolvedValue({ ok: true, value: {} });
  mocks.draftFor.mockReset().mockReturnValue({ title: "", assistantTeamId: null });
});
afterEach(() => act(() => root.unmount()));

describe("group archive flows", () => {
  const team = { id: "g1", name: "Crew" } as never;

  it("archives after confirming and restores at once", async () => {
    const flows = run(() => useAssistantTeamFlows("hub" as never));
    expect(flows.canAct).toBe(true);
    flows.archive(team);
    await act(async () => undefined);
    expect(mocks.update).toHaveBeenLastCalledWith({ teamId: "g1", archived: true });
    await flows.restore(team);
    expect(mocks.update).toHaveBeenLastCalledWith({ teamId: "g1", archived: false });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("reports a refusal where it happened", async () => {
    mocks.update.mockResolvedValue({ ok: false, message: "no" });
    const flows = run(() => useAssistantTeamFlows("hub" as never));
    await flows.restore(team);
    expect(mocks.alert).toHaveBeenCalledWith("Could not restore the group", "no");
    flows.archive(team);
    await act(async () => undefined);
    expect(mocks.alert).toHaveBeenCalledWith("Could not archive the group", "no");
  });
});

describe("opening a group", () => {
  it("opens its chat by id", () => {
    run(() => useOpenAssistantTeam()).chat("hub" as never, "g1" as never);
    expect(mocks.navigate).toHaveBeenCalledWith("AssistantGroupChat", {
      environmentId: "hub",
      teamId: "g1",
    });
  });

  it("schedules in the group: a new task that posts in its chat", () => {
    run(() => useScheduleInGroup())("hub" as never, "g1" as never);
    expect(mocks.startEditor).toHaveBeenCalledWith({
      environmentId: "hub",
      environmentLabel: "Hub",
      draft: { title: "", assistantTeamId: "g1" },
    });
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsScheduledTaskNew");
    mocks.targets = [];
    run(() => useScheduleInGroup())("hub" as never, "g1" as never);
    expect(mocks.startEditor).toHaveBeenLastCalledWith(
      expect.objectContaining({ environmentLabel: "" }),
    );
  });
});
