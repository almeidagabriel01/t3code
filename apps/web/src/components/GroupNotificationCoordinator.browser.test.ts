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
  };
});
vi.mock("../state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  const web = { environmentId: "env-1", id: "p-web", title: "web" };
  return { environmentProjects: { projectsAtom: Atom.make([web]) } };
});

const { createGroupFinishedObserver, presentGroupFinished, startGroupNotifications } =
  await import("./GroupNotificationCoordinator");
const { assistantTeamEntriesAtom } = await import("../state/assistants");
const { openGroupTabsAtom, showGroupTab } = await import("../state/openGroupTabs");
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
    tab: "all",
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
  const notice = { title: "Ops finished", body: "All done.", projectId: null, tab: "all" } as const;
  const inP1 = { ...notice, projectId: "p1" as ProjectId, tab: "project:p1" } as const;
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  // The chat the user is looking at needs no notice: in All, or in the tab of the work's project.
  const open = (tab: string | null, teamId: string = TEAM) =>
    ({ environmentId: ENV, teamId, tab }) as never;
  presentGroupFinished(router as never, ENV, TEAM, notice, []);
  presentGroupFinished(router as never, ENV, TEAM, notice, [open("all")]);
  presentGroupFinished(router as never, ENV, TEAM, inP1, [open("project:p1")]);
  // Another group's tab says nothing about this one: as if on All.
  presentGroupFinished(router as never, ENV, TEAM, notice, [open("project:p2", "other")]);
  // A second mount of the chat (a side panel) on the work's tab shows it too.
  presentGroupFinished(router as never, ENV, TEAM, inP1, [open("project:p2"), open("project:p1")]);
  expect(state.toast).not.toHaveBeenCalled();
  presentGroupFinished(router as never, ENV, TEAM, inP1, [open("project:p2")]);
  expect(state.toast).toHaveBeenCalledOnce();
  // A chat still choosing its tab shows none yet, so it is not All either.
  presentGroupFinished(router as never, ENV, TEAM, notice, [
    { environmentId: ENV, teamId: TEAM, tab: undefined } as never,
  ]);
  expect(state.toast).toHaveBeenCalledTimes(2);
  // Opening it switches the chat to the tab that shows the work.
  (state.toast.mock.calls[0]![0] as { actionProps: { onClick: () => void } }).actionProps.onClick();
  expect(localStorage.getItem(`t3code:group-tab:${ENV}:${TEAM}`)).toBe(
    JSON.stringify("project:p1"),
  );
  state.toast.mockClear();
  router.state.matches = [{ params: { environmentId: ENV, teamId: "other" } }] as never;
  presentGroupFinished(router as never, ENV, TEAM, notice, []);
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
  const notice = { title: "Ops finished", body: "All done.", projectId: null, tab: "all" } as const;
  state.mode = "off";
  presentGroupFinished(router as never, ENV, TEAM, notice, []);
  expect(notifications).not.toHaveBeenCalled();
  state.mode = "notifications-and-sound";
  presentGroupFinished(router as never, ENV, TEAM, notice, []);
  // Tagged per tab, so another tab's notice never replaces this one.
  expect(notifications).toHaveBeenCalledWith(
    "Ops finished",
    expect.objectContaining({ body: "All done.", tag: `group:${ENV}:${TEAM}:all` }),
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

it("watches every group, gives each finished tab its notice, and tells the open tabs apart", () => {
  const registry = AtomRegistry.make();
  const router = {
    state: { matches: [{ params: { environmentId: ENV, teamId: TEAM } }] },
    navigate: vi.fn(),
  };
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const stop = startGroupNotifications(registry, router as never);
  const tabbed = (open: ReadonlyArray<string>) => {
    const team = teamWith(open.length > 0);
    const scopes = open.map((projectId) => ({
      projectId,
      unreadCount: 0,
      waiting: false,
      readSeq: 0,
      openTasks: 1,
    }));
    return { environmentId: ENV, team: { ...team, chat: { ...team.chat!, scopes } } };
  };
  const shown = (tab: string) =>
    showGroupTab(registry, "route", { environmentId: ENV, teamId: TEAM, tab } as never);
  // On p-web's tab: the web work ending says nothing; p-other ending is a notice.
  const hide = shown("project:p-web");
  registry.set(teamEntries, [tabbed(["p-web", "p-other"])]);
  registry.set(teamEntries, [tabbed(["p-other"])]);
  expect(state.toast).not.toHaveBeenCalled();
  registry.set(teamEntries, [tabbed([])]);
  expect(state.toast).toHaveBeenCalledOnce();
  // Two tabs ending at once give two notices.
  hide();
  shown("general");
  state.toast.mockClear();
  registry.set(teamEntries, [tabbed(["p-web", "p-other"])]);
  registry.set(teamEntries, [tabbed([])]);
  expect(
    state.toast.mock.calls.map(([toast]) => (toast as { description: string }).description),
  ).toEqual(["[web] Work finished", "Work finished"]);
  stop();
});

it("drops only its own mount's tab when a chat closes", () => {
  const registry = AtomRegistry.make();
  const tab = (value: string) => ({ environmentId: ENV, teamId: TEAM, tab: value }) as never;
  const closeRoute = showGroupTab(registry, "route", tab("project:p1"));
  const closePanel = showGroupTab(registry, "panel", tab("all"));
  closeRoute();
  expect([...registry.get(openGroupTabsAtom).values()]).toEqual([tab("all")]);
  closePanel();
  expect(registry.get(openGroupTabsAtom).size).toBe(0);
});
