export const BRANCH_NAMING_COPY = {
  title: "Worktree branch naming",
  modes: {
    static: {
      title: "Static prefix",
      description: "Add your prefix to the generated branch name.",
    },
    semantic: {
      title: "Semantic prefix",
      description: "Let the model choose feat/, fix/, refactor/, or another prefix.",
    },
    custom: {
      title: "Custom instructions",
      description: "Generate the complete name with no added prefix or suffix.",
    },
  },
  prefixHint: "Use t3 or t3/ for t3/add-search. Leave empty for no prefix.",
  instructionsHint: "Append instructions to the naming prompt.",
} as const;

export const WORKTREE_CLEANUP_COPY = {
  projectModes: {
    title: "Automatic worktree cleanup",
    choices: [
      {
        mode: "inherit",
        label: "Inherit",
        description: "Use each machine's worktree cleanup settings.",
      },
      {
        mode: "off",
        label: "Off",
        description: "Keep this project's worktrees until you delete them manually.",
      },
      { mode: "custom", label: "Custom", description: "Use these rules for this project." },
    ],
  },
  onDelete: {
    title: "Delete worktrees with deleted threads",
    description:
      "Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept.",
  },
  merged: {
    title: "Delete merged worktrees",
    description:
      "Remove worktrees whose commits are already in the default branch, merged locally or through a pull request.",
    options: { off: "Off", "right-away": "Right away", "after-days": "After" },
    daysUnused: "Days unused",
  },
  inactive: {
    title: "Delete inactive worktrees",
    description:
      "Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept.",
  },
  settled: {
    title: "Delete settled worktrees",
    description:
      "Remove worktrees this many days after their thread settles. Set 0 days to remove them at the next cleanup. Branches and thread history are kept.",
  },
  days: "Days",
  runnerCopy: {
    title: "Delete the Linux copy too",
    description:
      "When cleanup deletes a worktree, also delete its copy on the Runner's Linux machine.",
  },
  keepWhen: {
    title: "Keep worktrees with",
    choices: [
      {
        value: "any-local-files",
        label: "Any local files",
        description: "Includes ignored files, except node_modules.",
      },
      {
        value: "uncommitted-changes",
        label: "Uncommitted changes",
        description: "Keeps edits and untracked files. Deletes ignored files, including .env.",
      },
      {
        value: "tracked-changes",
        label: "Edited tracked files",
        description: "Deletes untracked and ignored files, including .env.",
      },
    ],
  },
} as const;
