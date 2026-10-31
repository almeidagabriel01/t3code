import type {
  ImessageChannelAccess,
  ImessageChannelErrorCode,
  ImessageChannelSettings,
} from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";

const FULL_DISK_ACCESS_HELP =
  "Open System Settings → Privacy & Security → Full Disk Access and turn on T3 Code, then check again.";

const ERROR_COPY: Readonly<Record<ImessageChannelErrorCode, string>> = {
  full_disk_access_missing: `T3 Code cannot read Messages. ${FULL_DISK_ACCESS_HELP}`,
  database_unavailable: "T3 Code could not open the Messages database. Check again in a moment.",
  automation_denied:
    "Allow T3 Code to control Messages in System Settings → Privacy & Security → Automation.",
  messages_not_signed_in: "Messages is not signed in on this Mac. Sign in to iMessage, then retry.",
};

export function imessageErrorLabel(code: ImessageChannelErrorCode): string {
  return ERROR_COPY[code];
}

export function imessageStatusLabel(
  settings: Pick<ImessageChannelSettings, "status" | "lastError">,
): string {
  switch (settings.status) {
    case "disabled":
      return "Off";
    case "running":
      return "Running";
    case "error":
      return (
        (settings.lastError && ERROR_COPY[settings.lastError]) ||
        "iMessage stopped working. Check the permissions and try again."
      );
  }
}

const DELIVERY_COPY: Readonly<Record<string, string>> = {
  automation_denied: "T3 Code is not allowed to control Messages",
  messages_not_signed_in: "Messages is not signed in",
  chat_not_found: "the chat was not found in Messages",
  timeout: "Messages did not answer in time",
  unknown: "of an unknown error",
};

export function imessageDeliveryErrorLabel(
  error: NonNullable<ImessageChannelSettings["lastDeliveryError"]>,
  nowMs: number = Date.now(),
): string {
  const when = formatRelativeTimeLabel(error.at, nowMs);
  return `The last reply was not delivered (${when ? `${when}, ` : ""}${DELIVERY_COPY[error.code] ?? DELIVERY_COPY.unknown}).`;
}

/** The access row: a granted flag and, when not granted, the sentence that says what to do. */
export function imessageAccessState(access: ImessageChannelAccess | null): {
  readonly granted: boolean;
  readonly message: string | null;
} {
  switch (access) {
    case "ok":
      return { granted: true, message: null };
    case "messages_not_signed_in":
      return { granted: false, message: ERROR_COPY.messages_not_signed_in };
    case "database_unavailable":
      return { granted: false, message: ERROR_COPY.database_unavailable };
    default:
      return { granted: false, message: FULL_DISK_ACCESS_HELP };
  }
}

/** Why the switch cannot be turned on yet, or null when it can. */
export function imessageSwitchHint(input: {
  readonly granted: boolean;
  readonly handleCount: number;
}): string | null {
  if (!input.granted && input.handleCount === 0) {
    return "Grant Full Disk Access and add at least one phone number or email before turning this on.";
  }
  if (!input.granted) return "Grant Full Disk Access before turning this on.";
  if (input.handleCount === 0)
    return "Add at least one phone number or email before turning this on.";
  return null;
}
