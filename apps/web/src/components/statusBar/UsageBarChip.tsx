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
  name,
  resets,
  bar,
  extra,
  divider,
  fillClass,
  textClass,
  tickPercent,
  delta,
}: {
  readonly percent: number;
  readonly name: string;
  readonly resets: string | null;
  readonly bar: boolean;
  /** A window beyond session and weekly; it drops out first on narrow windows. */
  readonly extra: boolean;
  /** Draws the rule that separates this window from the one before it. */
  readonly divider: boolean;
  readonly fillClass: string;
  readonly textClass: string;
  readonly tickPercent: number | null;
  readonly delta: { readonly text: string; readonly className: string } | null;
}) {
  return (
    <span className={cn("flex items-center gap-1.5 whitespace-nowrap", extra && "max-xl:hidden")}>
      {divider ? <span aria-hidden className="mx-1 h-3 w-px bg-foreground/15" /> : null}
      <span className="text-muted-foreground">{name}</span>
      <span className={cn("font-medium text-foreground", textClass)}>{percent}%</span>
      {bar ? (
        <PaceBar
          thin
          usedPercent={percent}
          fillClass={fillClass}
          tickPercent={tickPercent}
          className="w-9"
        />
      ) : null}
      {resets === null ? null : (
        <span className="text-muted-foreground/70 max-lg:hidden">{resets}</span>
      )}
      {delta === null ? null : (
        <span className={cn("text-3xs max-lg:hidden", delta.className)}>{delta.text}</span>
      )}
    </span>
  );
}
