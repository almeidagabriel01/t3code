import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useRightPanelStore } from "../../rightPanelStore";
import type { RightPanelToolKind } from "../../rightPanelToolKinds";
import { RIGHT_PANEL_TOOLS } from "../chat/rightPanelTools";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";

const PROJECT_PANELS = [
  { kind: "activity", searchTerms: ["activity", "finished", "failed", "waiting", "runs", "inbox"] },
  { kind: "memory", searchTerms: ["memory", "memories", "remember", "forget", "rules"] },
  {
    kind: "heavy-work",
    searchTerms: ["heavy work", "queue", "tests", "builds", "commands", "stop", "priority"],
  },
] as const satisfies ReadonlyArray<{ kind: RightPanelToolKind; searchTerms: string[] }>;

/** "Show project activity / memory / heavy work in panel" for the open thread. */
export function projectPanelPaletteItems(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null,
): CommandPaletteActionItem[] {
  if (thread === null) return [];
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  return PROJECT_PANELS.map(({ kind, searchTerms }) => {
    const { label, icon: Icon } = RIGHT_PANEL_TOOLS[kind];
    return {
      kind: "action",
      value: `action:open-${kind}-panel`,
      searchTerms: [...searchTerms, "project", "panel"],
      title: `Show project ${label.toLowerCase()} in panel`,
      icon: <Icon className={ITEM_ICON_CLASS} />,
      run: async () => {
        useRightPanelStore.getState().open(threadRef, kind);
      },
    };
  });
}
