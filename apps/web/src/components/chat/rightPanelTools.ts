import {
  ActivityIcon,
  BrainIcon,
  HourglassIcon,
  NotebookPenIcon,
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
  activity: {
    label: "Activity",
    icon: ActivityIcon,
    shortcut: "A",
    disabledReason: "Project activity is only available from a project thread.",
    unavailableHint: "Available from a project thread.",
  },
  memory: {
    label: "Memory",
    icon: BrainIcon,
    shortcut: "E",
    disabledReason: "Project memory is only available from a project thread.",
    unavailableHint: "Available from a project thread.",
  },
  "heavy-work": {
    label: "Heavy work",
    icon: HourglassIcon,
    shortcut: "H",
    disabledReason: "Heavy work is only available from a project thread.",
    unavailableHint: "Available from a project thread.",
  },
};
