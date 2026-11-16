/** The Notifications page's fixed labels; Settings search reads these same strings. */
export const NOTIFICATIONS_COPY = {
  agentActivity: "Agent activity",
  deviceNotifications: "Device Notifications",
  androidLiveUpdates: "Agent Live Updates",
  androidOngoingActivity: "Ongoing Agent Activity",
  liveActivityUpdates: "Live Activity Updates",
  turnOffLiveActivity: "Turn off Live Activity preference",
  liveUpdateSettings: "Live Update Settings",
  installNewerBuild: "Install a newer app build to enable notifications",
  unavailableOnPlatform: "Unavailable on this platform",
} as const;

export const NOTIFICATIONS_PAGE_LABELS: readonly string[] = Object.values(NOTIFICATIONS_COPY);
