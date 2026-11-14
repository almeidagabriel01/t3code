import * as Notifications from "expo-notifications";

import { setAndroidThreadOnScreen } from "./androidNotifications";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import {
  assistantGroupDeepLink,
  routeAgentNotificationResponseOnce,
  threadDeepLinkOnScreen,
} from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

let pathnameLink: string | null = null;
let deepLinkOnScreen: string | null = null;
/** The tab each mounted group chat shows, by mount, keyed to its chat's link. */
const groupTabs = new Map<string, { readonly path: string; readonly tab: string | null }>();

function updateDeepLinkOnScreen(): void {
  const shown = [...groupTabs.values()].findLast((entry) => entry.path === pathnameLink);
  deepLinkOnScreen =
    pathnameLink === null || shown === undefined
      ? pathnameLink
      : assistantGroupDeepLink(pathnameLink, shown.tab);
  setAndroidThreadOnScreen(deepLinkOnScreen);
}

/** Called with the workspace pathname on every root navigation state change. */
export function setAgentNotificationPathname(pathname: string): void {
  pathnameLink = threadDeepLinkOnScreen(pathname);
  updateDeepLinkOnScreen();
}

/**
 * A group chat at `path` shows `tab` (null: no tab row) until the returned function drops this
 * mount's entry, so a push for another tab of the open chat still shows.
 */
export function showAgentNotificationGroupTab(
  mount: string,
  path: string,
  tab: string | null,
): () => void {
  groupTabs.set(mount, { path, tab });
  updateDeepLinkOnScreen();
  return () => {
    groupTabs.delete(mount);
    updateDeepLinkOnScreen();
  };
}

/**
 * App-lifetime notification routing: foreground presentation suppresses the
 * thread already on screen, and taps (including the cold-start tap) open the
 * notification's deep link through `navigate`.
 */
export function installAgentNotificationNavigation(navigate: (href: string) => void): () => void {
  const handledResponseIds = new Set<string>();
  Notifications.setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(foregroundNotificationBehavior(notification, deepLinkOnScreen)),
  });

  const handleResponse = (response: Notifications.NotificationResponse): void => {
    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  void consumeLastAgentNotificationResponse({
    getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
    clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
    handleResponse,
  });

  return () => {
    subscription.remove();
    Notifications.setNotificationHandler(null);
  };
}
