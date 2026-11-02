import { compactImessageHandle } from "@t3tools/client-runtime/state/imessageChannel";
import type { ImessageChannelAccess, ImessageChannelSettings } from "@t3tools/contracts";

const ERROR_SENTENCES: Record<string, string> = {
  full_disk_access_missing:
    "T3 Code cannot read Messages. Turn on Full Disk Access for T3 Code, then check again.",
  database_unavailable: "The Messages database could not be opened on the Mac.",
  automation_denied:
    "T3 Code is not allowed to control Messages. Allow it in System Settings → Privacy & Security → Automation.",
  messages_not_signed_in: "Messages is not signed in to iMessage on the Mac.",
};

const DELIVERY_SENTENCES: Record<string, string> = {
  rate_limited: "Messages is rate limiting replies.",
  timeout: "Messages took too long to send a reply.",
  network: "A reply could not be sent.",
  unknown: "A reply could not be delivered.",
};

export function imessageStatusLabel(settings: ImessageChannelSettings): string {
  switch (settings.status) {
    case "disabled":
      return "Off";
    case "running":
      return "Running";
    case "error":
      return (
        (settings.lastError && ERROR_SENTENCES[settings.lastError]) ||
        "iMessage could not start on the Mac."
      );
  }
}

/** A failed reply shown beside the status; null when the last delivery worked. */
export function imessageDeliveryNote(settings: ImessageChannelSettings): string | null {
  const error = settings.lastDeliveryError;
  return error ? (DELIVERY_SENTENCES[error.code] ?? DELIVERY_SENTENCES.unknown!) : null;
}

/** The Full Disk Access row; null access means the check has not answered yet. */
export function imessageAccessRow(access: ImessageChannelAccess | null): {
  readonly label: string;
  readonly description: string;
} {
  switch (access) {
    case null:
      return {
        label: "Checking…",
        description: "Asking the Mac whether T3 Code can read Messages.",
      };
    case "ok":
      return { label: "Granted", description: "T3 Code can read Messages on the Mac." };
    case "full_disk_access_missing":
      return {
        label: "Not granted",
        description:
          "On the Mac, open System Settings → Privacy & Security → Full Disk Access and turn on T3 Code, then check again",
      };
    case "messages_not_signed_in":
      return { label: "Not signed in", description: ERROR_SENTENCES.messages_not_signed_in! };
    case "database_unavailable":
      return { label: "Unavailable", description: ERROR_SENTENCES.database_unavailable! };
  }
}

/** Why Use iMessage cannot be turned on yet; null when it can. */
export function imessageEnableBlocker(
  access: ImessageChannelAccess | null,
  settings: Pick<ImessageChannelSettings, "allowedHandles" | "selfHandles">,
): string | null {
  if (access !== "ok") return "Grant access first.";
  return settings.allowedHandles.length + settings.selfHandles.length === 0
    ? "Add at least one number or email first."
    : null;
}

/** The trimmed handle, or why it cannot be added. The server does the real validation. */
export function parseImessageHandle(
  input: string,
  existing: ReadonlyArray<string>,
): { readonly handle: string } | { readonly error: string } {
  const handle = compactImessageHandle(input);
  if (handle === "") return { error: "Type a phone number or an email." };
  return existing.some((entry) => compactImessageHandle(entry) === handle)
    ? { error: "That is already added." }
    : { handle };
}
