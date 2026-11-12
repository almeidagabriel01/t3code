import type { AgendaDay, AgendaEntry } from "@t3tools/client-runtime/scheduledTaskAgenda";
import { scheduledTaskColor } from "@t3tools/client-runtime/scheduledTaskAgenda";
import { kanbanColor } from "@t3tools/client-runtime/state/kanbanLogic";
import type { ScheduledTask } from "@t3tools/contracts";
import { CheckIcon, LoaderIcon, XIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "../../lib/utils";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });

const PAST_ICON = {
  never: null,
  running: LoaderIcon,
  succeeded: CheckIcon,
  failed: XIcon,
} satisfies Record<ScheduledTask["lastRunStatus"], unknown>;

const PAST_LABEL: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "ran",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
};

function entryDetail(entry: AgendaEntry): string {
  const time = timeFormat.format(entry.at);
  if (entry.past) return `${time} · ${PAST_LABEL[entry.task.lastRunStatus]}`;
  return entry.runs > 1 ? `${time} · ${entry.runs} runs` : time;
}

/** Today and tomorrow side by side, each a stack of task blocks in time order. */
export function ScheduledTasksAgenda(props: {
  readonly days: ReadonlyArray<AgendaDay>;
  readonly onOpenTask: (task: ScheduledTask) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2" role="group" aria-label="Agenda">
      {props.days.map((day, index) => (
        <section
          key={day.start}
          aria-label={index === 0 ? "Today" : "Tomorrow"}
          className="min-w-0"
        >
          <h3 className="flex items-baseline gap-1.5 px-1 pb-1.5 text-xs">
            <span className="font-medium text-foreground">
              {index === 0 ? "Today" : "Tomorrow"}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {dayFormat.format(day.start)}
            </span>
          </h3>
          {day.entries.length === 0 ? (
            <p className="rounded-md border border-dashed border-foreground/12 px-2 py-3 text-center text-2xs text-muted-foreground">
              Nothing scheduled
            </p>
          ) : (
            <ol className="flex flex-col gap-1">
              {day.entries.map((entry) => (
                <li key={`${entry.task.id}:${entry.at}:${entry.past}`}>
                  <AgendaBlock entry={entry} onOpen={() => props.onOpenTask(entry.task)} />
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}

function AgendaBlock(props: { readonly entry: AgendaEntry; readonly onOpen: () => void }) {
  const { entry } = props;
  const color = kanbanColor(scheduledTaskColor(entry.task.id));
  const Icon = entry.past ? PAST_ICON[entry.task.lastRunStatus] : null;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      style={
        {
          "--agenda-color": color,
          "--agenda-bg": `color-mix(in srgb, ${color} 14%, transparent)`,
          "--agenda-bg-hover": `color-mix(in srgb, ${color} 22%, transparent)`,
        } as CSSProperties
      }
      className={cn(
        "relative grid w-full cursor-pointer gap-0.5 overflow-hidden rounded-md py-1 ps-2.5 pe-1.5 text-left outline-none transition-colors",
        "bg-(--agenda-bg) hover:bg-(--agenda-bg-hover)",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        entry.past && "opacity-70",
      )}
    >
      <span aria-hidden className="absolute inset-y-0 start-0 w-[3px] bg-(--agenda-color)" />
      <span className="truncate text-xs font-medium text-foreground">{entry.task.title}</span>
      <span className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground tabular-nums">
        {Icon ? <Icon aria-hidden className="size-3 shrink-0" /> : null}
        <span className="truncate">{entryDetail(entry)}</span>
      </span>
    </button>
  );
}
