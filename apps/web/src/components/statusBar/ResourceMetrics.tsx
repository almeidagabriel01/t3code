import * as Schema from "effect/Schema";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  formatCpu,
  formatMemory,
  type ResourceUsage,
} from "@t3tools/client-runtime/state/resourceTree";

export const CPU_COLUMN = "w-12 text-right";
export const MEM_COLUMN = "w-16 text-right";
export const GUTTER = "flex w-5 shrink-0 items-center justify-end";
export const METRICS = "flex shrink-0 items-center tabular-nums";
export const FOCUS_RING =
  "outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
/** Every row's first line: the same padding and hover, so all sections share one grid. */
export const ROW_LINE = "relative flex min-h-8 items-center gap-2 py-1 pr-3 pl-3";
export const ROW_HOVER = "transition-colors duration-100 hover:bg-foreground/6";
/** Glyph slot every row starts with, so names line up across sections. */
export const GLYPH =
  "flex size-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5";
/** Aligns a row's second line, or its expanded details, under its name. */
export const UNDER_NAME = "pl-9";

/** `null` reads "--" (not sampled yet); `undefined` leaves the cells empty (nothing to sample here). */
export function Metrics({
  usage,
  className,
}: {
  readonly usage: Pick<ResourceUsage, "cpuPercent" | "rssBytes"> | null | undefined;
  readonly className?: string;
}) {
  return (
    <div className={cn(METRICS, "text-2xs text-muted-foreground", className)}>
      <span className={CPU_COLUMN}>
        {usage === undefined ? null : usage === null ? "--" : formatCpu(usage.cpuPercent)}
      </span>
      <span className={MEM_COLUMN}>
        {usage === undefined ? null : usage === null ? "--" : formatMemory(usage.rssBytes)}
      </span>
    </div>
  );
}

const SECTIONS_KEY = "t3code:resource-manager:sections";
const SectionsSchema = Schema.Record(Schema.String, Schema.Boolean);

/** Each section keeps the open state the user left it in, so closing the popup does not reset it. */
function useSectionOpen(id: string, defaultOpen: boolean) {
  const [sections, setSections] = useLocalStorage(SECTIONS_KEY, {}, SectionsSchema);
  const setOpen = (open: boolean) => setSections((current) => ({ ...current, [id]: open }));
  return [sections[id] ?? defaultOpen, setOpen] as const;
}

/**
 * One collapsible section of the Resource Manager: label and count, controls, aggregated usage in
 * the rows' columns, and a chevron in the gutter. The whole header toggles it; controls sit above.
 */
export function ResourceSection({
  sectionId,
  title,
  icon,
  count,
  usage,
  controls,
  defaultOpen = true,
  children,
}: {
  readonly sectionId: string;
  readonly title: string;
  readonly icon: ReactNode;
  readonly count: number;
  /** Omitted for sections whose rows have no usage, so the header shows no empty metrics. */
  readonly usage?: ResourceUsage | null;
  readonly controls?: ReactNode;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useSectionOpen(sectionId, defaultOpen);
  return (
    <section aria-label={title} className="border-t border-foreground/10 first:border-t-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className={cn(ROW_LINE, ROW_HOVER, "min-h-9")}>
          <CollapsibleTrigger
            aria-label={`${title} (${count})`}
            className={cn("absolute inset-0", FOCUS_RING)}
          />
          <span className={cn(GLYPH, "pointer-events-none")}>{icon}</span>
          <span className="pointer-events-none flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="truncate text-xs font-semibold text-foreground/90">{title}</span>
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{count}</span>
          </span>
          {controls === undefined ? null : (
            <div className="relative flex shrink-0 items-center gap-1">{controls}</div>
          )}
          {usage === undefined ? null : <Metrics usage={usage} className="pointer-events-none" />}
          <span className={cn(GUTTER, "pointer-events-none")}>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
                !open && "-rotate-90",
              )}
            />
          </span>
        </div>
        {/* Sections hold long, live lists: animating their height would relayout every row. */}
        <CollapsiblePanel animate={false}>{children}</CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
