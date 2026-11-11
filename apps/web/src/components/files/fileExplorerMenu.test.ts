import { describe, expect, it } from "vite-plus/test";

import { toFileExplorerMenuItems } from "./fileExplorerMenu";

describe("toFileExplorerMenuItems", () => {
  it("separates groups, maps flags and splices the extra group after its anchor", () => {
    const items = toFileExplorerMenuItems(
      [
        [{ id: "new-file", label: "New File", disabled: true }],
        [{ id: "duplicate", label: "Duplicate" }],
        [
          { id: "open-in", label: "Open in" },
          { id: "toggle-dotfiles", label: "Show Dotfiles", checked: false },
        ],
        [{ id: "delete", label: "Delete", destructive: true, shortcut: "Del" }],
      ],
      {
        openInChildren: [{ id: "editor:vscode", label: "VS Code" }],
        extraGroup: [{ id: "copy-mention", label: "Copy Mention", icon: "hash" }],
        extraGroupAfter: "duplicate",
      },
    );
    expect(items).toEqual([
      { id: "new-file", label: "New File", icon: "file-plus", disabled: true },
      { id: "duplicate", label: "Duplicate", icon: "files", separatorBefore: true },
      { id: "copy-mention", label: "Copy Mention", icon: "hash", separatorBefore: true },
      {
        id: "open-in",
        label: "Open in",
        icon: "external-link",
        separatorBefore: true,
        children: [{ id: "editor:vscode", label: "VS Code" }],
      },
      { id: "toggle-dotfiles", label: "Show Dotfiles", checked: false },
      {
        id: "delete",
        label: "Delete",
        icon: "trash",
        separatorBefore: true,
        destructive: true,
        detail: "Del",
      },
    ]);
  });

  it("drops an empty Open in submenu and appends an extra group without an anchor", () => {
    const items = toFileExplorerMenuItems(
      [
        [
          { id: "open-in", label: "Open in" },
          { id: "reveal", label: "Reveal in Finder" },
        ],
      ],
      { extraGroup: [{ id: "add-to-chat", label: "Add to Chat", icon: "message-square-plus" }] },
    );
    expect(items.map((item) => [item.id, item.separatorBefore ?? false])).toEqual([
      ["reveal", false],
      ["add-to-chat", true],
    ]);
  });
});
