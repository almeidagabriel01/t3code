import type { WeekBarSplit } from "@t3tools/shared/usagePace";

import { cn } from "../../lib/utils";

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

export type PaceBarSplit = WeekBarSplit & { readonly remaining: boolean };

export function PaceBar({
  usedPercent,
  fillClass,
  tickPercent,
  className,
  split,
  thin = false,
}: {
  readonly usedPercent: number;
  readonly fillClass: string;
  readonly tickPercent: number | null;
  readonly className: string;
  /** The scoped models' share of the week, as lighter steps of the fill colour. */
  readonly split?: PaceBarSplit | null | undefined;
  readonly thin?: boolean;
}) {
  const width = clampPercent(usedPercent);
  const models = split?.models ?? [];
  const modelTotal = models.reduce((sum, model) => sum + model.percent, 0);
  const lighter = cn("h-full shrink-0 opacity-50", fillClass);
  return (
    <span
      className={cn(
        "relative shrink-0 rounded-full bg-foreground/12",
        thin ? "h-[5px]" : "h-1.5",
        className,
      )}
      {...(split ? { role: "img", "aria-label": split.label } : {})}
    >
      <span className="absolute inset-0 overflow-hidden rounded-full">
        {split && !split.remaining && width > 0 ? (
          <span className="flex h-full overflow-hidden rounded-full" style={{ width: `${width}%` }}>
            <span
              className={cn("h-full shrink-0", fillClass)}
              style={{ width: `${((width - modelTotal) / width) * 100}%` }}
            />
            {models.map(({ name, percent }) => (
              <span
                key={name}
                data-week-split="model"
                className={lighter}
                style={{ width: `${(percent / width) * 100}%` }}
              />
            ))}
          </span>
        ) : (
          <span
            className={cn("block h-full rounded-full", fillClass)}
            style={{ width: `${width}%` }}
          />
        )}
        {split?.remaining && modelTotal > 0 ? (
          <span
            className="absolute inset-y-0 flex"
            style={{ left: `${100 - modelTotal}%`, width: `${modelTotal}%` }}
          >
            {models.map(({ name, percent }) => (
              <span
                key={name}
                data-week-split="model"
                className={lighter}
                style={{ width: `${(percent / modelTotal) * 100}%` }}
              />
            ))}
          </span>
        ) : null}
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
  split,
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
  readonly split?: PaceBarSplit | null | undefined;
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
          split={split}
          className="w-9"
        />
      ) : null}
      {resets === null ? null : (
        <span className="text-muted-foreground max-lg:hidden">{resets}</span>
      )}
      {delta === null ? null : (
        <span className={cn("text-3xs max-lg:hidden", delta.className)}>{delta.text}</span>
      )}
    </span>
  );
}
