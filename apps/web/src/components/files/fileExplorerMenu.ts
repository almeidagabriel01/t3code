import type { ContextMenuItem } from "@t3tools/contracts";
import type {
  FileExplorerAction,
  FileExplorerActionId,
} from "@t3tools/client-runtime/file-explorer";

const ACTION_ICONS: Record<FileExplorerActionId, string | undefined> = {
  "new-file": "file-plus",
  "new-folder": "folder-plus",
  "copy-file": "clipboard",
  "copy-path": "copy",
  "copy-relative-path": "link",
  duplicate: "files",
  "add-as-project": "briefcase",
  "open-in-terminal": "square-terminal",
  "view-file": "file",
  "open-in-browser": "globe",
  "open-markdown-preview": "eye",
  download: "download",
  "collapse-folder": "list-collapse",
  "find-in-folder": "text-search",
  "open-in": "external-link",
  reveal: "folder-tree",
  rename: "pencil",
  delete: "trash",
  "collapse-all": "chevrons-down-up",
  refresh: "refresh-cw",
  // A checked item shows its checkmark instead.
  "toggle-dotfiles": undefined,
};

export interface ExtraMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
}

/** Flattens grouped actions into one menu; each group after the first starts with a separator. */
export function toFileExplorerMenuItems(
  groups: readonly (readonly FileExplorerAction[])[],
  options: {
    readonly openInChildren?: readonly ContextMenuItem[];
    /** T3-only items, such as mentioning the file in chat, shown as their own group. */
    readonly extraGroup?: readonly ExtraMenuItem[];
    readonly extraGroupAfter?: FileExplorerActionId;
  } = {},
): ContextMenuItem[] {
  const allGroups: (readonly (FileExplorerAction | ExtraMenuItem)[])[] = [...groups];
  if (options.extraGroup && options.extraGroup.length > 0) {
    const index = groups.findIndex((group) =>
      group.some((action) => action.id === options.extraGroupAfter),
    );
    allGroups.splice(index < 0 ? allGroups.length : index + 1, 0, options.extraGroup);
  }
  return allGroups.flatMap((group, groupIndex) =>
    group.flatMap((action, index): ContextMenuItem[] => {
      const isAction = !("icon" in action);
      const icon = isAction ? ACTION_ICONS[action.id as FileExplorerActionId] : action.icon;
      const children = action.id === "open-in" ? options.openInChildren : undefined;
      if (action.id === "open-in" && (children === undefined || children.length === 0)) return [];
      const item: ContextMenuItem = {
        id: action.id,
        label: action.label,
        ...(icon === undefined ? {} : { icon }),
        ...(groupIndex > 0 && index === 0 ? { separatorBefore: true } : {}),
        ...(isAction && action.disabled ? { disabled: true } : {}),
        ...(isAction && action.destructive ? { destructive: true } : {}),
        ...(isAction && action.checked !== undefined ? { checked: action.checked } : {}),
        ...(isAction && action.shortcut ? { detail: action.shortcut } : {}),
        ...(children ? { children } : {}),
      };
      return [item];
    }),
  );
}
