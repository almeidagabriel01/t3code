/** The fixed text of the Maintenance page's storage and keep-awake sections. */
export const DATABASE_STORAGE_COPY = {
  title: "Reclaim database space",
  description:
    "These databases still hold space freed by history cleanup. Run the command on each machine to reclaim it. It restarts the background service. Quit the desktop app first if it hosts the environment.",
} as const;

export const KEEP_AWAKE_COPY = {
  title: "Keep this computer awake",
  modes: { off: "Off", "while-working": "While agents are working", always: "Always" },
  note: "Your computer can't run agents while it sleeps. Closing a laptop lid still puts it to sleep unless it is plugged in with an external display.",
  unsupported: "Not available on this system",
} as const;

export const WORKTREE_SNAPSHOTS_COPY = {
  title: "Worktree snapshots",
  description:
    "Before cleanup removes a worktree it saves your uncommitted and untracked changes. Restore brings them back until they expire.",
  keepForever: "Keep until I delete them",
} as const;

export const TOOL_OUTPUT_HISTORY_COPY = {
  title: "Tool output history",
  description:
    "Screenshots, file contents and command output in thread history are replaced by a short summary after this many days.",
  summarize: "Summarize old tool output",
  daysToKeep: "Days to keep",
  daysSheet: "Days to keep tool output",
} as const;

export const IDLE_AGENTS_COPY = {
  title: "Idle agents",
  description:
    "An idle Claude agent process is closed after this many minutes without activity. The conversation resumes on your next message.",
  minutes: "Minutes before closing",
  minutesSheet: "Minutes before an idle agent closes",
} as const;
