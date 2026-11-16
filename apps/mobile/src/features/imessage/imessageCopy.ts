import { CHANNEL_SHARED_LABELS } from "../settings/components/channelCopy";

/** The iMessage page's fixed labels; Settings search reads these same strings. */
export const IMESSAGE_COPY = {
  intro:
    "Talk to your assistants from Messages on the Mac running T3 Code. Start with @Name to pick an assistant; Jarvis answers otherwise, and the chat stays with the last one picked. Send @ on its own to list them. It works while T3 Code is running on that Mac.",
  access: "Access",
  fullDiskAccess: "Full Disk Access",
  connection: "Connection",
  use: "Use iMessage",
  self: {
    title: "Chat with yourself",
    footer:
      "Your own numbers and emails. The assistant answers in the same chat, and each reply starts with its name.",
    fieldLabel: "Your number or email",
  },
  others: {
    title: "Other accounts",
    footer:
      "Numbers and emails allowed to message the assistants, for when Messages on the Mac uses its own Apple ID.",
    fieldLabel: "Allowed number or email",
  },
} as const;

export const IMESSAGE_PAGE_LABELS: readonly string[] = [
  IMESSAGE_COPY.intro,
  IMESSAGE_COPY.access,
  IMESSAGE_COPY.fullDiskAccess,
  IMESSAGE_COPY.connection,
  IMESSAGE_COPY.use,
  ...Object.values(IMESSAGE_COPY.self),
  ...Object.values(IMESSAGE_COPY.others),
  ...CHANNEL_SHARED_LABELS,
];
