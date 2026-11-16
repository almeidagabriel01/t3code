import type { SettingsSearchItem } from "./settingsSearch";

/** Text the Memory rows draw in states other than the one the index item describes. */
export const MEMORY_SETTINGS_COPY = {
  noPendingProcessing: "No pending processing reported",
  saveDisabledDescription: "Saved memories stay. Turn on memory to save new memories.",
  sharingUnavailableTitle: "Sharing unavailable",
  sharingLoadingTitle: "Loading sharing",
  sharingNotLoadedDescription: "Sharing settings are not loaded yet.",
  sharingHubTitle: "This device is the hub",
  sharingHubDescription: "Memory is on. Devices you add here share memory with it.",
  sharingMemberTitle: "Memory sharing",
  sharingMemberDescription: (hubName: string) => `Shares memory with ${hubName}.`,
  sharingOffTitle: "Sharing off",
  sharingOffDescription:
    "Sharing is off. Memory stays on this device. Make this device the hub, or add it from the hub's Memory settings.",
  importDescription: (formats: string) =>
    `Import supported ${formats} memories from the selected device. Other providers are not supported. Memory write and file read permissions are required.`,
} as const;

export const MEMORY_SETTINGS_SEARCH_ITEMS = [
  { id: "memory-generation", title: "Memory", to: "/settings/memory" },
  {
    id: "memory-remember-conversations",
    title: "Remember conversations",
    description:
      "Finished conversations are summarized into memory. Turning this off stops new summaries and keeps saved memories.",
    to: "/settings/memory",
    searchTerms: ["summaries"],
  },
  {
    id: "memory-model",
    targetId: "memory-remember-conversations",
    title: "Memory model",
    description:
      "Automatic follows the text generation model. Choose a separate model for memory summaries.",
    to: "/settings/memory",
  },
  { id: "memory-agent-access", title: "Agent access", to: "/settings/memory" },
  {
    id: "memory-allow-agent-access",
    title: "Allow agent memory access",
    description:
      "Allow agents on this device to use memory within their granted scope. This is separate from sharing memories between devices.",
    to: "/settings/memory",
  },
  { id: "memory-status", title: "Memory status", to: "/settings/memory" },
  { id: "memory-status-hub", title: "Hub", to: "/settings/memory" },
  { id: "memory-status-storage", title: "Storage", to: "/settings/memory" },
  { id: "memory-status-coverage", title: "Coverage", to: "/settings/memory" },
  {
    id: "memory-status-processing",
    title: "Processing",
    to: "/settings/memory",
    searchTerms: [MEMORY_SETTINGS_COPY.noPendingProcessing],
  },
  { id: "memory-hub-diagnostics", title: "Hub diagnostics", to: "/settings/memory" },
  {
    id: "memory-reconcile-sync",
    title: "Reconcile sync",
    description: "Rearm eligible held work on this device.",
    to: "/settings/memory",
  },
  { id: "memory-sharing", title: "Sharing", to: "/settings/memory" },
  {
    id: "memory-sharing-mode",
    targetId: "memory-sharing",
    title: MEMORY_SETTINGS_COPY.sharingOffTitle,
    description: MEMORY_SETTINGS_COPY.sharingOffDescription,
    to: "/settings/memory",
    searchTerms: [
      MEMORY_SETTINGS_COPY.sharingHubTitle,
      MEMORY_SETTINGS_COPY.sharingHubDescription,
      MEMORY_SETTINGS_COPY.sharingMemberTitle,
      MEMORY_SETTINGS_COPY.sharingMemberDescription("hub"),
      "make this device the hub leave sharing turn sharing off",
    ],
  },
  {
    id: "memory-hub-devices",
    targetId: "memory-sharing",
    title: "Devices",
    to: "/settings/memory",
  },
  {
    id: "memory-add-device",
    targetId: "memory-sharing",
    title: "Add device",
    description: "Choose a connected device that supports memory.",
    to: "/settings/memory",
    searchTerms: ["replace key remove member"],
  },
  {
    id: "memory-original-conversations",
    targetId: "memory-sharing",
    title: "Original conversations",
    to: "/settings/memory",
  },
  {
    id: "memory-conversation-access",
    targetId: "memory-sharing",
    title: "Conversation access",
    description:
      "When a memory points to a conversation on this device, these devices can open the original. Removing a device applies to later requests and to results still on the hub.",
    to: "/settings/memory",
    searchTerms: ["owner source access"],
  },
  {
    id: "memory-allow-device",
    targetId: "memory-sharing",
    title: "Allow device",
    to: "/settings/memory",
  },
  { id: "memory-import", title: "Import memories", to: "/settings/memory" },
  {
    id: "memory-import-providers",
    title: "Provider memories",
    description: MEMORY_SETTINGS_COPY.importDescription("provider"),
    to: "/settings/memory",
  },
  { id: "memory-browse-scope", title: "Memory scope", to: "/settings/memory" },
  { id: "memory-scope", title: "Scope", to: "/settings/memory" },
  {
    id: "memory-save",
    title: "Save a memory",
    description: "Add something you want this device to remember.",
    to: "/settings/memory",
    searchTerms: [MEMORY_SETTINGS_COPY.saveDisabledDescription, "remember something"],
  },
  { id: "memory-search", title: "Search memories", to: "/settings/memory" },
  {
    id: "memory-quarantined",
    title: "Quarantined memories",
    description: "Review memories that need attention.",
    to: "/settings/memory",
  },
  { id: "memory-rules", title: "Rules", to: "/settings/memory" },
  {
    id: "memory-rules-agents-follow",
    title: "Rules agents follow",
    description:
      "Learned when you say what agents must always or never do. Only what you type becomes a rule.",
    to: "/settings/memory",
    searchTerms: ["new rule forget"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
