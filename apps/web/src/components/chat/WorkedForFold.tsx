import { type TimestampFormat } from "@t3tools/contracts/settings";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { TimelineRowTimestamp } from "./TimelineRowParts";

export function WorkedForFold(props: {
  label: string;
  expanded: boolean;
  loading: boolean;
  error: string | null | undefined;
  onToggle: () => void;
  createdAt: string;
  timestampFormat: TimestampFormat;
  children?: ReactNode;
}) {
  return (
    <div className="group/timeline-row border-b border-border/60 pb-2 pe-0.5 pt-1">
      <div className="relative flex items-center gap-1">
        <button
          type="button"
          aria-expanded={props.expanded}
          data-scroll-anchor-ignore
          onClick={props.onToggle}
          aria-busy={props.loading}
          className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <span>
            {props.label}
            {props.error ? ` · ${props.error}` : ""}
          </span>
          {props.expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </button>
        <TimelineRowTimestamp
          createdAt={props.createdAt}
          timestampFormat={props.timestampFormat}
          className="ms-auto"
        />
      </div>
      {props.children}
    </div>
  );
}
