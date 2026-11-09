import type { AssistantTeam, AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
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

const { createGroupFinishedObserver, presentGroupFinished } =
  await import("./GroupNotificationCoordinator");

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
  const observe = createGroupFinishedObserver(report);
  observe([{ environmentId: ENV, team: teamWith(false) }]);
  observe([{ environmentId: ENV, team: teamWith(true) }]);
  observe([{ environmentId: ENV, team: teamWith(false) }]);
  observe([{ environmentId: ENV, team: teamWith(false) }]);
  expect(report).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(ENV, TEAM, { title: "Ops finished", body: "All done." });
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
  const notice = { title: "Ops finished", body: "All done." };
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  // The chat the user is looking at needs no notice.
  presentGroupFinished(router as never, ENV, TEAM, notice);
  expect(state.toast).not.toHaveBeenCalled();
  router.state.matches = [{ params: { environmentId: ENV, teamId: "other" } }] as never;
  presentGroupFinished(router as never, ENV, TEAM, notice);
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
  const notifications = vi.fn(function (this: { addEventListener: () => void; close: () => void }) {
    this.addEventListener = () => {};
    this.close = () => {};
  });
  vi.stubGlobal("Notification", Object.assign(notifications, { permission: "granted" }));
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const router = { state: { matches: [] }, navigate: vi.fn() };
  const notice = { title: "Ops finished", body: "All done." };
  state.mode = "off";
  presentGroupFinished(router as never, ENV, TEAM, notice);
  expect(notifications).not.toHaveBeenCalled();
  state.mode = "notifications";
  presentGroupFinished(router as never, ENV, TEAM, notice);
  expect(notifications).toHaveBeenCalledWith(
    "Ops finished",
    expect.objectContaining({ body: "All done." }),
  );
  vi.unstubAllGlobals();
});
