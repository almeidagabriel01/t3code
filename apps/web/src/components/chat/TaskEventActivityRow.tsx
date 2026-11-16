import { taskEventActivitySegments } from "@t3tools/client-runtime/assistantTasks";
import { type TaskEventStatus } from "@t3tools/shared/assistantTaskEvents";
import {
  BanIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  CircleSlashIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

// The project gives way first, then the title; the status and action never truncate. A chip
// (the All tab's only sign of the project) never shrinks below its own cap; the title truncates.
const SEGMENT_CLASS = {
  title: "min-w-0 truncate font-medium text-foreground/90",
  label: "shrink-0",
  project: "min-w-0 shrink-[999] truncate",
} as const;

const STATUS_ICON: Record<TaskEventStatus, { icon: LucideIcon; className: string }> = {
  completed: { icon: CheckCircle2Icon, className: "text-success" },
  failed: { icon: XCircleIcon, className: "text-destructive" },
  cancelled: { icon: BanIcon, className: "text-muted-foreground" },
  interrupted: { icon: CircleSlashIcon, className: "text-warning" },
};

/** One compact line for a task that changed state: status, title, what happened, and a way in. */
export function TaskEventActivityRow(props: {
  title: string;
  label: string;
  /** Where the task belongs, after the status; it truncates before the title does. */
  project?: string | null;
  status: TaskEventStatus | null;
  onOpen: () => void;
  /** What the row opens, for screen readers. */
  action?: string;
  /** A tag after the label, such as the project; never interactive, the row is a button. */
  chip?: ReactNode;
  /** The visible action at the row's end. */
  actionLabel?: string;
}) {
  const { icon: Icon, className } =
    props.status === null
      ? { icon: CircleDotIcon, className: "text-muted-foreground" }
      : STATUS_ICON[props.status];
  return (
    <button
      type="button"
      onClick={props.onOpen}
      aria-label={`${props.action ?? "Open task"} ${props.title}`.trim()}
      data-task-event-activity={props.status ?? "updated"}
      className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
    >
      <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />
      {taskEventActivitySegments(props).map((segment) => (
        <span
          key={segment.kind}
          className={cn(
            SEGMENT_CLASS[segment.kind],
            segment.kind === "title" && props.chip != null && "min-w-10",
          )}
        >
          {segment.separated ? `· ${segment.text}` : segment.text}
        </span>
      ))}
      {props.chip}
      <span className="ms-auto shrink-0 underline-offset-2">{props.actionLabel ?? "Open"}</span>
    </button>
  );
}
