import { type TaskEventStatus } from "@t3tools/shared/assistantTaskEvents";
import {
  BanIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  CircleSlashIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";

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
  status: TaskEventStatus | null;
  onOpen: () => void;
  /** What the row opens, for screen readers. */
  action?: string;
}) {
  const { icon: Icon, className } =
    props.status === null
      ? { icon: CircleDotIcon, className: "text-muted-foreground" }
      : STATUS_ICON[props.status];
  return (
    <button
      type="button"
      onClick={props.onOpen}
      aria-label={`${props.action ?? "Open task"} ${props.title}`}
      data-task-event-activity={props.status ?? "updated"}
      className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
    >
      <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />
      <span className="min-w-0 truncate font-medium text-foreground/90">{props.title}</span>
      <span className="shrink-0">· {props.label}</span>
      <span className="ms-auto shrink-0 underline-offset-2">Open</span>
    </button>
  );
}
