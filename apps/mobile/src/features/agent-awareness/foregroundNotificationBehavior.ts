import type { Notification, NotificationBehavior } from "expo-notifications";

import { deepLinkShows, extractAgentNotificationDeepLink } from "./notificationPayload";

const SHOW: NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

const SUPPRESS: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

export function foregroundNotificationBehavior(
  notification: Notification,
  deepLinkOnScreen: string | null,
): NotificationBehavior {
  return deepLinkShows(deepLinkOnScreen, extractAgentNotificationDeepLink({ notification }))
    ? SUPPRESS
    : SHOW;
}
