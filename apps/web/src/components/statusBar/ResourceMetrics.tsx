import { cn } from "../../lib/utils";
import type { ResourceUsage } from "./resourceUsage.logic";
import { formatMemory } from "./statusBar.logic";

export const CPU_COLUMN = "w-12 text-right";
export const MEM_COLUMN = "w-16 text-right";
export const GUTTER = "flex w-5 shrink-0 items-center justify-end";
export const METRICS = "flex shrink-0 items-center tabular-nums";

// Shares of the whole machine are small; one decimal keeps a busy process from reading as 0%.
export const formatCpu = (cpuPercent: number) =>
  cpuPercent > 0 && cpuPercent < 10 ? `${cpuPercent.toFixed(1)}%` : `${Math.round(cpuPercent)}%`;

export function Metrics({
  usage,
  className,
}: {
  readonly usage: Pick<ResourceUsage, "cpuPercent" | "rssBytes"> | null;
  readonly className?: string;
}) {
  return (
    <div className={cn(METRICS, "text-2xs text-muted-foreground", className)}>
      <span className={CPU_COLUMN}>{usage === null ? "--" : formatCpu(usage.cpuPercent)}</span>
      <span className={MEM_COLUMN}>{usage === null ? "--" : formatMemory(usage.rssBytes)}</span>
    </div>
  );
}
