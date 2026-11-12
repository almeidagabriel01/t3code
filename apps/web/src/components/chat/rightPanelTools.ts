import {
  CalendarClockIcon,
  NotebookPenIcon,
  SquareKanbanIcon,
  type LucideIcon,
} from "lucide-react";

import type { RightPanelToolKind } from "../../rightPanelToolKinds";

export interface RightPanelToolMeta {
  readonly label: string;
  readonly icon: LucideIcon;
  /** Launcher letter; must not repeat another surface's. */
  readonly shortcut: string;
  readonly disabledReason: string;
  readonly unavailableHint: string;
}

export const RIGHT_PANEL_TOOLS: Record<RightPanelToolKind, RightPanelToolMeta> = {
  notes: {
    label: "Notes",
    icon: NotebookPenIcon,
    shortcut: "N",
    disabledReason: "Notes are only available for projects on an environment with notes.",
    unavailableHint: "Available when a project is open.",
  },
  kanban: {
    label: "Kanban",
    icon: SquareKanbanIcon,
    shortcut: "K",
    disabledReason: "Boards are only available on an environment with boards.",
    unavailableHint: "Available on an environment with boards.",
  },
  "scheduled-tasks": {
    label: "Scheduled tasks",
    icon: CalendarClockIcon,
    shortcut: "C",
    disabledReason: "Scheduled tasks are only available from a project thread.",
    unavailableHint: "Available from a project thread.",
  },
};
