import {
  contextWindowReading,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/state/context-window";
import type { ReactNode } from "react";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const TONE = {
  error: "text-destructive-foreground",
  warning: "text-warning-foreground",
} as const;

/** The context window in words, shared by the composer meter and Thread details. */
export function ContextWindowTooltipContent(props: {
  readonly usage: ContextWindowSnapshot;
  /** Whose session it is, when the composer is not the session's own (a group member). */
  readonly owner?: ReactNode;
}) {
  const { usage } = props;
  const { usedPercent, maxTokens } = contextWindowReading(usage);
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  const threshold = usage.autoCompactThreshold ?? null;
  return (
    <>
      {props.owner === undefined ? null : (
        <span className="text-muted-foreground">{props.owner}</span>
      )}
      <span className="text-foreground">
        {usedPercent !== null
          ? `Context: ${usedPercent}% used`
          : `Context: ${usedTokens} tokens used`}
      </span>
      {maxTokens !== null ? (
        <span className="text-muted-foreground">
          {usage.usedTokens.toLocaleString("en-US")} of {maxTokens.toLocaleString("en-US")} tokens
        </span>
      ) : null}
      {threshold !== null && threshold > 0 ? (
        <span className="text-muted-foreground">
          {formatContextWindowCompactionMessage(threshold)}
        </span>
      ) : null}
    </>
  );
}

/** A compact ring and percent for the composer's controls row; the tooltip carries the numbers. */
export function ComposerContextMeter(props: {
  readonly usage: ContextWindowSnapshot;
  readonly owner?: ReactNode;
}) {
  const reading = contextWindowReading(props.usage);
  const label =
    reading.usedPercent !== null
      ? `${reading.usedPercent}%`
      : formatContextWindowTokens(props.usage.usedTokens);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="meter"
            aria-label="Context window"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={reading.usedPercent ?? undefined}
            aria-valuetext={
              reading.usedPercent !== null ? `${reading.usedPercent}% used` : `${label} tokens used`
            }
            data-testid="composer-context-meter"
            className={cn(
              "inline-flex h-7 shrink-0 cursor-default items-center gap-1 px-1 text-xs text-muted-foreground tabular-nums sm:h-6",
              reading.tone !== null && TONE[reading.tone],
            )}
          />
        }
      >
        <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 -rotate-90">
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            strokeWidth="2"
            className="stroke-foreground/15"
          />
          {reading.usedPercent === null ? null : (
            <circle
              cx="8"
              cy="8"
              r={RADIUS}
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              className="stroke-current"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - reading.usedPercent / 100)}
            />
          )}
        </svg>
        <span>{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <ContextWindowTooltipContent usage={props.usage} owner={props.owner} />
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
