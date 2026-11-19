import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { WorkingRow } from "@t3tools/client-runtime/workingConsumers";
import type { AssistantTeamId, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { memo, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

const VISIBLE_ROWS = 5;

/** Opens the row's thread, or its group when only the server's running list names the member. */
export function openWorkingRow(
  row: WorkingRow<EnvironmentThreadShell>,
  open: {
    readonly thread: (threadRef: ScopedThreadRef) => void;
    readonly group: (environmentId: EnvironmentId, teamId: AssistantTeamId) => void;
  },
) {
  const { consumer } = row.item;
  if (consumer.threadId !== null) {
    open.thread(scopeThreadRef(consumer.environmentId, consumer.threadId));
  } else {
    open.group(consumer.environmentId, consumer.groupId);
  }
}

export function WorkingRowButton(props: {
  readonly row: WorkingRow<EnvironmentThreadShell>;
  readonly selected?: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="working-row"
      aria-current={props.selected ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-hidden hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.selected && "bg-accent",
      )}
      onClick={props.onOpen}
    >
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <Spinner aria-hidden role="presentation" size="md" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{props.row.title}</span>
      </span>
      <span className="truncate ps-5 text-xs text-muted-foreground">{props.row.line}</span>
    </button>
  );
}

/** Everything working now (`workingItems`), below Needs you. Absent while none work. */
export const WorkingSection = memo(function WorkingSection(props: {
  readonly rows: ReadonlyArray<WorkingRow<EnvironmentThreadShell>>;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
  readonly onOpenGroup: (environmentId: EnvironmentId, teamId: AssistantTeamId) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (props.rows.length === 0) return null;
  const shown = showAll ? props.rows : props.rows.slice(0, VISIBLE_ROWS);
  const more = props.rows.length - shown.length;
  return (
    <>
      <li
        data-testid="sidebar-working-header"
        className="flex list-none items-center gap-1 px-(--sidebar-row-content-inset) pt-3 pb-1 text-xs font-medium text-secondary-label"
      >
        Working
        <span className="font-normal text-muted-foreground tabular-nums">{props.rows.length}</span>
      </li>
      {shown.map((row) => (
        <li key={row.item.key} className="list-none px-1">
          <WorkingRowButton
            row={row}
            onOpen={() =>
              openWorkingRow(row, { thread: props.onOpenThread, group: props.onOpenGroup })
            }
          />
        </li>
      ))}
      {more > 0 || showAll ? (
        <li className="list-none px-1">
          <Button size="micro" variant="ghost-muted" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show less" : `Show ${more} more`}
          </Button>
        </li>
      ) : null}
    </>
  );
});
