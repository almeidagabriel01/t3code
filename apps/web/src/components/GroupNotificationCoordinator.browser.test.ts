import type { AssistantTeam, AssistantTeamId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "notifications" as string,
  inApp: true,
  toast: vi.fn(),
  sound: vi.fn(),
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.toast as never, close: vi.fn() },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  getClientSettings: () =>
    ({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound as never,
}));

vi.mock("../state/assistants", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    assistantTeamEntriesAtom: Atom.make<ReadonlyArray<unknown>>([]).pipe(Atom.keepAlive),
    openGroupTabAtom: Atom.make<unknown>(null).pipe(Atom.keepAlive),
  };
});
vi.mock("../state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  const web = { environmentId: "env-1", id: "p-web", title: "web" };
  return { environmentProjects: { projectsAtom: Atom.make([web]) } };
});

const { createGroupFinishedObserver, presentGroupFinished, startGroupNotifications } =
  await import("./GroupNotificationCoordinator");
const { assistantTeamEntriesAtom, openGroupTabAtom } = await import("../state/assistants");
// The mock above makes it writable, standing in for the server's group updates.
const teamEntries = assistantTeamEntriesAtom as unknown as Atom.Writable<ReadonlyArray<unknown>>;

const ENV = "env-1" as EnvironmentId;
const TEAM = "t1" as AssistantTeamId;
const teamWith = (working: boolean, name = "Ops"): AssistantTeam =>
  ({
    id: TEAM,
    name,
    chat: { latestSeq: 3, readSeq: 0, unreadCount: 1, working, preview: "All done." },
  }) as AssistantTeam;

it("reports a group once when its work goes from open to none, and forgets removed groups", () => {
  const report = vi.fn();
  const observe = createGroupFinishedObserver(report, () => []);
  observe([{ environmentId: ENV, team: teamWith(false) }]);
  observe([{ environmentId: ENV, team: teamWith(true) }]);
  observe([{ environmentId: ENV, team: teamWith(false) }]);
  observe([{ environmentId: ENV, team: teamWith(false) }]);
  expect(report).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(ENV, TEAM, {
    title: "Ops finished",
    body: "All done.",
    projectId: null,
  });
  // A group that left and came back starts fresh, so it cannot report a stale transition.
  observe([]);
  observe([{ environmentId: ENV, team: teamWith(false) }]);
  expect(report).toHaveBeenCalledOnce();
});

it("shows a toast that opens the chat unless that chat is open and focused", () => {
  const router = {
    state: { matches: [{ params: { environmentId: ENV, teamId: TEAM } }] },
    navigate: vi.fn(),
  };
  const notice = { title: "Ops finished", body: "All done.", projectId: null };
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  // The chat the user is looking at needs no notice: in All, or in the tab of the work's project.
  const open = (tab: string | null, teamId: string = TEAM) =>
    ({ environmentId: ENV, teamId, tab }) as never;
  presentGroupFinished(router as never, ENV, TEAM, notice, null);
  presentGroupFinished(router as never, ENV, TEAM, notice, open("all"));
  presentGroupFinished(
    router as never,
    ENV,
    TEAM,
    { ...notice, projectId: "p1" as ProjectId },
    open("project:p1"),
  );
  // Another group's tab says nothing about this one: as if on All.
  presentGroupFinished(router as never, ENV, TEAM, notice, open("project:p2", "other"));
  expect(state.toast).not.toHaveBeenCalled();
  presentGroupFinished(
    router as never,
    ENV,
    TEAM,
    { ...notice, projectId: "p1" as ProjectId },
    open("project:p2"),
  );
  expect(state.toast).toHaveBeenCalledOnce();
  // Opening it switches the chat to the tab that shows the work.
  (state.toast.mock.calls[0]![0] as { actionProps: { onClick: () => void } }).actionProps.onClick();
  expect(localStorage.getItem(`t3code:group-tab:${ENV}:${TEAM}`)).toBe(
    JSON.stringify("project:p1"),
  );
  state.toast.mockClear();
  router.state.matches = [{ params: { environmentId: ENV, teamId: "other" } }] as never;
  presentGroupFinished(router as never, ENV, TEAM, notice, null);
  expect(state.toast).toHaveBeenCalledOnce();
  const toast = state.toast.mock.calls[0]![0] as {
    title: string;
    description: string;
    actionProps: { onClick: () => void };
  };
  expect([toast.title, toast.description]).toEqual(["Ops finished", "All done."]);
  toast.actionProps.onClick();
  expect(router.navigate).toHaveBeenCalledWith({
    to: "/group/$environmentId/$teamId",
    params: { environmentId: ENV, teamId: TEAM },
  });
});

it("stays quiet in the background when notifications are off, and uses desktop ones when on", () => {
  let click = () => {};
  const notifications = vi.fn(function (this: {
    addEventListener: (type: string, listener: () => void) => void;
    close: () => void;
  }) {
    this.addEventListener = (_type, listener) => (click = listener);
    this.close = () => {};
  });
  vi.stubGlobal("Notification", Object.assign(notifications, { permission: "granted" }));
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const router = { state: { matches: [] }, navigate: vi.fn() };
  const notice = { title: "Ops finished", body: "All done.", projectId: null };
  state.mode = "off";
  presentGroupFinished(router as never, ENV, TEAM, notice, null);
  expect(notifications).not.toHaveBeenCalled();
  state.mode = "notifications-and-sound";
  presentGroupFinished(router as never, ENV, TEAM, notice, null);
  expect(notifications).toHaveBeenCalledWith(
    "Ops finished",
    expect.objectContaining({ body: "All done." }),
  );
  expect(state.sound).toHaveBeenCalledOnce();
  // Clicking the desktop notice opens the group's chat.
  click();
  expect(router.navigate).toHaveBeenCalledWith({
    to: "/group/$environmentId/$teamId",
    params: { environmentId: ENV, teamId: TEAM },
  });
  state.mode = "notifications";
  vi.unstubAllGlobals();
});

it("watches every group and tells the open chat's other tabs apart from the one on screen", () => {
  const registry = AtomRegistry.make();
  const router = {
    state: { matches: [{ params: { environmentId: ENV, teamId: TEAM } }] },
    navigate: vi.fn(),
  };
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const stop = startGroupNotifications(registry, router as never);
  const finish = (previewProjectId: string) => {
    registry.set(teamEntries, [{ environmentId: ENV, team: teamWith(true) }]);
    const idle = teamWith(false);
    registry.set(teamEntries, [
      { environmentId: ENV, team: { ...idle, chat: { ...idle.chat!, previewProjectId } } },
    ]);
  };
  registry.set(openGroupTabAtom, { environmentId: ENV, teamId: TEAM, tab: "project:p-web" });
  finish("p-web");
  expect(state.toast).not.toHaveBeenCalled();
  registry.set(openGroupTabAtom, { environmentId: ENV, teamId: TEAM, tab: "project:p-other" });
  finish("p-web");
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Ops finished", description: "[web] All done." }),
  );
  stop();
});
