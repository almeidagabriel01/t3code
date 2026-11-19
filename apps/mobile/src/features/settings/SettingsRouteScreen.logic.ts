import { NOTIFICATIONS_COPY } from "./notificationsCopy";

export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios" || platform === "android"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: NOTIFICATIONS_COPY.unavailableOnPlatform };
}
