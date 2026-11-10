import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    update: vi.fn(),
    setDismissed: vi.fn(),
    markRead: vi.fn(),
    alert: vi.fn(),
    navigate: vi.fn(),
    select: vi.fn(),
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
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.select,
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { set: mocks.set } }));
vi.mock("../../state/assistants", () => ({
  useAssistantActions: () => ({ canAct: true }),
  useAssistantTeamActions: () => ({ canAct: true, update: mocks.update }),
  useAssistantGroupActions: () => ({ canMarkRead: true, markRead: mocks.markRead }),
  setAssistantTaskDismissed: mocks.setDismissed,
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
import { useAssistantFlows, useAssistantTeamFlows } from "./useAssistantFlows";
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
  for (const fn of [
    mocks.update,
    mocks.setDismissed,
    mocks.markRead,
    mocks.alert,
    mocks.navigate,
    mocks.startEditor,
    mocks.set,
  ])
    fn.mockReset();
  mocks.update.mockResolvedValue({ ok: true, value: {} });
  mocks.markRead.mockResolvedValue({ ok: true, value: undefined });
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

describe("group read flows", () => {
  it("marks read up to the newest message and unread through the server's own rule", async () => {
    const flows = run(() => useAssistantTeamFlows("hub" as never));
    expect(flows.canMarkRead).toBe(true);
    await flows.markRead({ id: "g1", chat: { latestSeq: 7 } } as never);
    expect(mocks.markRead).toHaveBeenLastCalledWith("g1", { readSeq: 7 });
    await flows.markRead({ id: "g1" } as never);
    expect(mocks.markRead).toHaveBeenLastCalledWith("g1", { readSeq: 0 });
    await flows.markUnread({ id: "g1" } as never);
    expect(mocks.markRead).toHaveBeenLastCalledWith("g1", { unread: true });
    expect(mocks.alert).not.toHaveBeenCalled();
    mocks.markRead.mockResolvedValue({ ok: false, message: "no" });
    await flows.markUnread({ id: "g1" } as never);
    expect(mocks.alert).toHaveBeenCalledWith("Could not update the group", "no");
  });
});

describe("opening a group", () => {
  it("shows its chat in the detail column", () => {
    run(() => useOpenAssistantTeam()).chat("hub" as never, "g1" as never);
    expect(mocks.select).toHaveBeenCalledWith({
      name: "AssistantGroupChat",
      params: { environmentId: "hub", teamId: "g1" },
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

describe("task dismissal flows", () => {
  it.each([
    ["dismissTask", true, "Could not dismiss the task"],
    ["restoreTask", false, "Could not restore the task"],
  ] as const)("%s alerts a refusal and passes the choice on", async (action, dismissed, title) => {
    mocks.setDismissed.mockResolvedValue({ ok: false, message: "Task is still running" });
    const flows = run(() => useAssistantFlows("env" as never));
    await act(async () => flows[action]("t1" as never));
    expect(mocks.setDismissed).toHaveBeenCalledWith("env", "t1", dismissed);
    expect(mocks.alert).toHaveBeenCalledWith(title, "Task is still running");
  });

  it("stays quiet when the server accepts", async () => {
    mocks.setDismissed.mockResolvedValue({ ok: true, value: undefined });
    const flows = run(() => useAssistantFlows("env" as never));
    await act(async () => flows.dismissTask("t1" as never));
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
