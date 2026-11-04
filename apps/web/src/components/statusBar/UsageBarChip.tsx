import { cn } from "../../lib/utils";

export function PaceBar({
  usedPercent,
  fillClass,
  tickPercent,
  className,
  thin = false,
}: {
  readonly usedPercent: number;
  readonly fillClass: string;
  readonly tickPercent: number | null;
  readonly className: string;
  readonly thin?: boolean;
}) {
  return (
    <span
      className={cn(
        "relative shrink-0 rounded-full bg-foreground/12",
        thin ? "h-[5px]" : "h-1.5",
        className,
      )}
    >
      <span className="absolute inset-0 overflow-hidden rounded-full">
        <span
          className={cn("block h-full rounded-full", fillClass)}
          style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }}
        />
      </span>
      {tickPercent === null ? null : (
        <span
          aria-hidden
          className="absolute -inset-y-px w-px -translate-x-1/2 bg-foreground"
          style={{ left: `${Math.min(100, Math.max(0, tickPercent))}%` }}
        />
      )}
    </span>
  );
}

export function UsageBarChip({
  percent,
  label,
  labelFirst,
  bar,
  fillClass,
  textClass,
  tickPercent,
  delta,
}: {
  readonly percent: number;
  readonly label: string;
  readonly labelFirst: boolean;
  readonly bar: boolean;
  readonly fillClass: string;
  readonly textClass: string;
  readonly tickPercent: number | null;
  readonly delta: { readonly text: string; readonly className: string } | null;
}) {
  return (
    // Lower-priority parts drop out first on narrow windows: extra windows, then the pace delta.
    <span
      className={cn("flex items-center gap-1 whitespace-nowrap", labelFirst && "max-xl:hidden")}
    >
      {bar ? (
        <PaceBar
          thin
          usedPercent={percent}
          fillClass={fillClass}
          tickPercent={tickPercent}
          className="w-8"
        />
      ) : null}
      <span className={textClass}>
        {labelFirst ? `${label} ` : ""}
        {percent}%{labelFirst ? "" : ` ${label}`}
      </span>
      {delta === null ? null : (
        <span className={cn("text-3xs max-lg:hidden", delta.className)}>{delta.text}</span>
      )}
    </span>
  );
}
