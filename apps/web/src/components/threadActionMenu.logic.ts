import { assistantIdFromThreadId, type ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

export type ThreadActionMenuId =
  | "find"
  | "open-side-by-side"
  | "new-thread-on-branch"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "share-guest"
  | "handoff"
  | "link-card"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "archive"
  | "delete"
  | "dismiss-task"
  | "restore-task"
  | "reset-assistant"
  | "assistant-work"
  | "assistant-settings";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly canFind?: boolean;
  /** Another thread is open, so this one can sit beside it. */
  readonly canOpenSideBySide?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
  /** An unlinked thread on a board-enabled environment the user can add cards to. */
  readonly canLinkCard?: boolean | undefined;
  /** The assistant whose current conversation this is; it can't be renamed, archived or deleted here. */
  readonly assistant?: { readonly name: string } | null | undefined;
  /** False where the row offering the menu has no title input. */
  readonly canRename?: boolean | undefined;
  /** An assistant's delegated subagent: it lives outside project lists, as the assistant chat does. */
  readonly outsideProjects?: boolean | undefined;
  /** Set when an assistant launched this thread as a task. */
  readonly assistantTask?:
    | { readonly dismissed: boolean; readonly canDismiss: boolean }
    | null
    | undefined;
}

/** A thread an assistant's chat delegated, which the sidebar lists under that assistant. */
export const isAssistantSubagent = (thread: {
  readonly lineage: { readonly parentThreadId: string | null };
}) =>
  thread.lineage.parentThreadId !== null &&
  assistantIdFromThreadId(thread.lineage.parentThreadId) !== null;

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "find",
    "open-side-by-side",
    "new-thread-on-branch",
    "project-settings",
    "mark-unread",
    "share-guest",
    "link-card",
    "assistant-work",
    "assistant-settings",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const isAssistant = state.assistant != null;
  // Branch, path and project actions belong to project threads.
  const inProject = !isAssistant && state.outsideProjects !== true;
  const branch = inProject ? state.branch : null;
  // Rename and regenerate drop out on some rows; the group's first item carries its separator.
  const titleGroup: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(isAssistant || state.canRename === false
      ? []
      : [{ id: "rename" as const, label: "Rename thread", icon: "pencil" }]),
    ...(state.supports.titleRegeneration && !isAssistant
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
  ];
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.canFind
      ? [{ id: "find" as const, label: "Find in thread", icon: "text-search" }]
      : []),
    ...(state.canOpenSideBySide
      ? [{ id: "open-side-by-side" as const, label: "Open side by side", icon: "columns-2" }]
      : []),
    ...(branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: preset.label,
                    detail: preset.whenLabel,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: "Custom…",
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    ...titleGroup.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item)),
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: "Share with guest", icon: "user-plus" }]
      : []),
    ...(state.assistantTask
      ? [
          state.assistantTask.dismissed
            ? { id: "restore-task" as const, label: "Restore task", icon: "rotate-ccw" }
            : {
                id: "dismiss-task" as const,
                label: "Dismiss task",
                icon: "x",
                disabled: !state.assistantTask.canDismiss,
              },
        ]
      : []),
    { id: "handoff", label: "Hand off to another agent", icon: "arrow-right-left" },
    ...(state.canLinkCard
      ? [{ id: "link-card" as const, label: "Link to board card…", icon: "link" }]
      : []),
    ...(state.projectFilter && inProject
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject && inProject
      ? [
          {
            id: "turn-into-project" as const,
            label: "Turn into project",
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Follow settings",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Never",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        ...(inProject ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(branch ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }] : []),
        { id: "copy-thread", label: "Thread", icon: "message-square" },
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    ...(inProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    ...(state.assistant
      ? [
          {
            id: "reset-assistant" as const,
            label: "Reset conversation",
            icon: "refresh-cw",
            separatorBefore: true,
            disabled: state.isRunning,
          },
          {
            id: "assistant-work" as const,
            label: `${state.assistant.name} work`,
            icon: "briefcase",
          },
          {
            id: "assistant-settings" as const,
            label: `${state.assistant.name} settings`,
            icon: "user-round",
          },
        ]
      : [
          {
            id: "archive" as const,
            label: "Archive thread",
            icon: "archive",
            disabled: state.isRunning,
            separatorBefore: true,
          },
          {
            id: "delete" as const,
            label: "Delete",
            destructive: true,
            icon: "trash",
          },
        ]),
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
