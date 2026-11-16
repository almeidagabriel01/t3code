/** The fixed text of the Threads page's usage-limit and auto-settle rows, and the Labs page. */
export const AUTO_SETTLE_COPY = {
  usageLimits: { title: "Usage limits" },
  resumeAfterLimits: {
    title: "Resume after usage limits",
    description:
      "Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread.",
  },
  snoozeUntilReset: {
    title: "Snooze until limits reset",
    description:
      "Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset.",
  },
  autoSettle: { title: "Auto-settle" },
  merged: { title: "Auto-settle merged threads" },
  inactive: { title: "Auto-settle inactive threads" },
  inactiveDays: { title: "Inactive days", sheetTitle: "Days before auto-settle" },
  acrossEnvironments: { title: "Across environments", description: "Auto-settle defaults differ" },
} as const;

export const LABS_COPY = {
  linkedEnvironments: {
    title: "Beta: Linked environments",
    description:
      "Let agents on a machine work on your other machines, and theirs on it. Turn it on for each machine. While off, nothing new starts over a link; running tasks finish.",
  },
  fastWorktreeCheckout: {
    title: "Beta: Fast worktree checkout",
    description:
      "On a Mac, clone new worktrees from a checkout cached in the T3 home folder instead of writing every file. Uses Git’s normal checkout when it can’t. Turning it off deletes the cache.",
  },
} as const;
