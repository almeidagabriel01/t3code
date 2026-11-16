import type { NotificationResponse } from "expo-notifications";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import {
  deepLinkShows,
  extractAgentNotificationDeepLink,
  routeAgentNotificationResponseOnce,
  threadDeepLinkOnScreen,
} from "./notificationPayload";

const android = vi.hoisted(() => ({ onScreen: vi.fn() }));
vi.mock("expo-notifications", () => ({}));
vi.mock("./androidNotifications", () => ({ setAndroidThreadOnScreen: android.onScreen }));
const { setAgentNotificationPathname, showAgentNotificationGroupTab } =
  await import("./notificationNavigation");

function responseWithData(data: Record<string, unknown>, identifier = "notification-1") {
  return {
    notification: {
      request: {
        identifier,
        content: {
          data,
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumeLastAgentNotificationResponse", () => {
  it("reports routing failures before clearing the response", async () => {
    const cause = new Error("notification routing unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({}, "notification-route") as NotificationResponse;
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: () => {
        throw cause;
      },
    });

    expect(clearLastResponse).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NotificationNavigationError",
        operation: "route",
        notificationId: "notification-route",
      }),
    );
  });
});

describe("extractAgentNotificationDeepLink", () => {
  it("uses explicit deep links from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/threads/env/thread",
          environmentId: "ignored",
          threadId: "ignored",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("opens a group chat from its explicit deep link, which wins over the thread ids", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/assistant-groups/env%201/team",
          environmentId: "env 1",
          threadId: "assistant:lead:g-1",
        }),
      ),
    ).toBe("/assistant-groups/env%201/team");
    expect(threadDeepLinkOnScreen("/assistant-groups/env/team")).toBe("/assistant-groups/env/team");
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/assistant-groups/env" })),
    ).toBeNull();
  });

  // The router leaves `:` and `@` unescaped in a path; pushes escape them, so both must agree.
  it.each([
    ["/threads/env/assistant:jarvis:1", "/threads/env/assistant%3Ajarvis%3A1"],
    ["/assistant-groups/env/team:a@b/tasks", "/assistant-groups/env/team%3Aa%40b"],
    ["/assistant-groups/env/team?tab=general", "/assistant-groups/env/team"],
    ["/threads/env/%E0%A4%A", null],
  ])("the screen at %s is the push link %s", (pathname, expected) => {
    expect(threadDeepLinkOnScreen(pathname)).toBe(expected);
  });

  it.each([
    ["/assistant-groups/env/team?tab=project%3Ap1", "/assistant-groups/env/team?tab=project%3Ap1"],
    ["/assistant-groups/env/team?tab=general", "/assistant-groups/env/team?tab=general"],
    ["/assistant-groups/env/team?tab=all", "/assistant-groups/env/team"],
    ["/assistant-groups/env/team?tab=", null],
    ["/assistant-groups/env/team?tab=general&x=1", null],
    ["/assistant-groups/env/team?view=general", null],
    ["/threads/env/thread?tab=general", null],
  ])("reads the tab a group's link names: %s", (deepLink, expected) => {
    expect(extractAgentNotificationDeepLink(responseWithData({ deepLink }))).toBe(expected);
  });

  it("falls back to the thread route from environment and thread ids", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          environmentId: "env 1",
          threadId: "thread/2",
        }),
      ),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("falls back to ids when explicit deep link is not an agent thread route", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/",
          environmentId: "env",
          threadId: "thread",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("ignores malformed or external links", () => {
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "https://example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/settings" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "//example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/threads/env/thread?x=1" })),
    ).toBeNull();
    expect(extractAgentNotificationDeepLink({})).toBeNull();
  });
});

describe("deepLinkShows", () => {
  const group = "/assistant-groups/env/team";
  it.each([
    ["the same thread", "/threads/env/t", "/threads/env/t", true],
    ["another thread", "/threads/env/t", "/threads/env/u", false],
    ["a group on All, for a tab", group, `${group}?tab=project%3Ap1`, true],
    ["a group on All, for an older push", group, group, true],
    ["a group on its tab", `${group}?tab=project%3Ap1`, `${group}?tab=project%3Ap1`, true],
    ["a group on another tab", `${group}?tab=general`, `${group}?tab=project%3Ap1`, false],
    ["a group on a tab, for an older push", `${group}?tab=general`, group, false],
    ["another group", group, "/assistant-groups/env/other?tab=general", false],
    ["nothing on screen", null, group, false],
  ] as const)("%s", (_name, onScreen, target, expected) => {
    expect(deepLinkShows(onScreen, target)).toBe(expected);
    const notification = { request: { content: { data: { deepLink: target } } } } as never;
    expect(foregroundNotificationBehavior(notification, onScreen).shouldShowBanner).toBe(!expected);
  });
});

describe("showAgentNotificationGroupTab", () => {
  it("names the open chat's tab while it is on screen, and drops only its own mount", () => {
    const group = "/assistant-groups/env/team";
    setAgentNotificationPathname(`${group}`);
    const closeRoute = showAgentNotificationGroupTab("route", group, "project:p1");
    expect(android.onScreen).toHaveBeenLastCalledWith(`${group}?tab=project%3Ap1`);
    const closeOther = showAgentNotificationGroupTab("other", "/assistant-groups/env/x", "general");
    expect(android.onScreen).toHaveBeenLastCalledWith(`${group}?tab=project%3Ap1`);
    closeOther();
    setAgentNotificationPathname("/threads/env/thread");
    expect(android.onScreen).toHaveBeenLastCalledWith("/threads/env/thread");
    setAgentNotificationPathname(group);
    expect(android.onScreen).toHaveBeenLastCalledWith(`${group}?tab=project%3Ap1`);
    closeRoute();
    expect(android.onScreen).toHaveBeenLastCalledWith(group);
    // Tabs still loading show none, so no tab's push is silenced, not even as All.
    const closePending = showAgentNotificationGroupTab("route", group, undefined);
    expect(android.onScreen).toHaveBeenLastCalledWith(null);
    closePending();
  });
});

describe("routeAgentNotificationResponseOnce", () => {
  it("retries a failed initial response and deduplicates it after navigation succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({ deepLink: "/threads/env/thread" }) as NotificationResponse;
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn().mockImplementationOnce(() => {
      throw new Error("navigation not ready");
    });
    const clearLastResponse = vi.fn(() => Promise.resolve());
    const consume = () =>
      consumeLastAgentNotificationResponse({
        getLastResponse: () => Promise.resolve(response),
        clearLastResponse,
        handleResponse: (response) =>
          routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate }),
      });

    await consume();
    expect(handledResponseIds.size).toBe(0);
    expect(clearLastResponse).not.toHaveBeenCalled();

    await consume();
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenLastCalledWith("/threads/env/thread");
    expect(clearLastResponse).toHaveBeenCalledOnce();

    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("discards malformed destination ids without leaving the response pending", async () => {
    const response = responseWithData({
      environmentId: "env",
      threadId: "\ud800",
    }) as NotificationResponse;
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn();
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: (response) =>
        routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate }),
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(clearLastResponse).toHaveBeenCalledOnce();
    expect(handledResponseIds.has("notification-1")).toBe(true);
  });

  it("does not navigate twice when the initial and listener responses refer to one notification", () => {
    const handledResponseIds = new Set<string>();
    const navigations: Array<string> = [];
    const response = responseWithData({
      environmentId: "env",
      threadId: "thread",
    });

    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });
    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });

    expect(navigations).toEqual(["/threads/env/thread"]);
  });
});
