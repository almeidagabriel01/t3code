/** The Memory page's fixed text; Settings search reads these same strings. */
export const MEMORY_COPY = {
  title: "Memory",
  chooser: {
    intro: "Choose the environment whose memory you want to manage.",
    missing: "Missing an environment? Connect it or update its server to use Memory.",
  },
  generation: {
    title: "Memory",
    description:
      "This app summarizes finished conversations. Turning this off stops new summaries and keeps saved memories.",
    remember: "Remember conversations",
    separateModel: "Use a separate memory model",
    model: "Memory model",
  },
  agentAccess: {
    title: "Agent memory access",
    description:
      "Allow agents in this environment to use memory. Sharing is managed separately. Turning this on does not increase saved task access.",
    allow: "Allow agent memory access",
  },
  status: { title: "Memory status" },
  syncDiagnostics: { title: "Memory sync" },
  scope: { title: "Memory scope", user: "User", thread: "Thread" },
  importScope: {
    title: "Import scope",
    footer: "Imports go to the scope selected here. Existing memories keep their scope.",
    user: "All projects",
    project: "This project",
    thread: "This thread",
  },
  rules: {
    title: "Rules",
    footer:
      "Learned when you say what agents must always or never do. Only what you type becomes a rule.",
  },
  memories: {
    title: "Memories",
    search: "Search memory",
    quarantined: "Include quarantined",
  },
  projectBinding: {
    title: "Project memory binding",
    createShared: "Create shared project binding",
    repositoryBinding: "Use repository binding",
  },
  import: {
    title: "Import memories",
    footer: "Import from Codex or Claude. Other providers are not supported.",
    source: "Project to import from",
    result: "Import result",
  },
  sharing: {
    title: "Sharing",
    makeHub: "Make this device the hub",
    turnOff: "Turn sharing off",
    devices: "Devices",
    addDevice: "Add device",
    addDeviceDescription: "Choose a connected device that supports memory.",
    originals: "Original conversations",
    originalsDescription:
      "When a memory points to a conversation on this device, these devices can open the original. Removing a device applies to later requests and to results still on the hub.",
  },
} as const;

const copy = MEMORY_COPY;

export const MEMORY_PAGE_LABELS: readonly string[] = [
  copy.title,
  ...Object.values(copy.chooser),
  ...Object.values(copy.generation),
  ...Object.values(copy.agentAccess),
  copy.status.title,
  copy.syncDiagnostics.title,
  ...Object.values(copy.scope),
  ...Object.values(copy.importScope),
  ...Object.values(copy.rules),
  ...Object.values(copy.memories),
  ...Object.values(copy.projectBinding),
  ...Object.values(copy.import),
  ...Object.values(copy.sharing),
];
