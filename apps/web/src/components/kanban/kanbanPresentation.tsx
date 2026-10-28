import {
  KANBAN_COLORS,
  KANBAN_PRIORITY_LABELS,
  kanbanColor,
} from "@t3tools/client-runtime/state/kanbanLogic";
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
import type { ComponentProps, ComponentType, CSSProperties, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

export const KANBAN_COLOR_NAMES = Object.keys(KANBAN_COLORS);

export function ColorDot({ color }: { readonly color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: kanbanColor(color) }}
    />
  );
}

export const PRIORITY_LABELS = KANBAN_PRIORITY_LABELS;

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

/** Reads as plain text until hovered or focused; for inline-edited values, not a boxed field. */
export function QuietInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "-mx-1.5 min-w-0 rounded-md bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground/70 hover:bg-accent/50 focus:bg-accent/60 disabled:pointer-events-none",
        className,
      )}
      {...props}
    />
  );
}

export function PropertyRow(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-2">
      <div className="flex min-h-7 items-center justify-between text-xs text-muted-foreground">
        {props.label}
        {props.action}
      </div>
      <div className="flex min-h-7 min-w-0 items-center">{props.children}</div>
    </div>
  );
}

export function ProgressBar(props: { readonly done: number; readonly total: number }) {
  const percent = props.total === 0 ? 0 : Math.round((props.done / props.total) * 100);
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={props.total}
      aria-valuenow={props.done}
      className="inline-block h-1 w-10 overflow-hidden rounded-full bg-muted"
    >
      <span
        className={cn(
          "block h-full rounded-full",
          props.done === props.total ? "bg-success" : "bg-primary/70",
        )}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}
