import type { KanbanLabel, KanbanPriority, KanbanTemplate } from "@t3tools/contracts";
import {
  BrushCleaningIcon,
  BugIcon,
  CircleAlertIcon,
  SignalHighIcon,
  SignalLowIcon,
  SignalMediumIcon,
  SparklesIcon,
  TagIcon,
  WrenchIcon,
} from "lucide-react";
import type { ComponentType, CSSProperties } from "react";

import { Badge } from "../ui/badge";

const COLORS: Record<string, string> = {
  slate: "#64748b",
  blue: "#3b82f6",
  amber: "#f59e0b",
  violet: "#8b5cf6",
  green: "#22c55e",
  red: "#ef4444",
  pink: "#ec4899",
  teal: "#14b8a6",
  orange: "#f97316",
};

export const KANBAN_COLOR_NAMES = Object.keys(COLORS);

function kanbanColor(color: string): string {
  return COLORS[color] ?? (/^#[0-9a-f]{3,8}$/i.test(color) ? color : COLORS.slate!);
}

export function ColorDot({ color }: { readonly color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: kanbanColor(color) }}
    />
  );
}

export const PRIORITY_LABELS: Record<KanbanPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};

export function PriorityIcon({ priority }: { readonly priority: KanbanPriority }) {
  if (priority === "none") return null;
  const Icon =
    priority === "urgent"
      ? CircleAlertIcon
      : priority === "high"
        ? SignalHighIcon
        : priority === "medium"
          ? SignalMediumIcon
          : SignalLowIcon;
  return (
    <Icon
      aria-label={PRIORITY_LABELS[priority]}
      className={
        priority === "urgent" ? "size-3.5 text-destructive" : "size-3.5 text-muted-foreground"
      }
    />
  );
}

const TEMPLATE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  bug: BugIcon,
  sparkles: SparklesIcon,
  wrench: WrenchIcon,
  broom: BrushCleaningIcon,
};

export function TemplateIcon({
  template,
}: {
  readonly template: Pick<KanbanTemplate, "icon" | "color" | "name">;
}) {
  const Icon = TEMPLATE_ICONS[template.icon] ?? TagIcon;
  return (
    <span role="img" aria-label={template.name} style={{ color: kanbanColor(template.color) }}>
      <Icon className="size-3.5" />
    </span>
  );
}

export function LabelChip({ label }: { readonly label: Pick<KanbanLabel, "name" | "color"> }) {
  return (
    <Badge
      variant="label"
      size="sm"
      style={{ "--label": kanbanColor(label.color) } as CSSProperties}
    >
      {label.name}
    </Badge>
  );
}
