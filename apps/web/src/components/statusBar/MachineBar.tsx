import {
  formatFreeMemory,
  heavyWork,
  machineSummaries,
  macNoteGauge,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import { linuxLine } from "@t3tools/client-runtime/state/runnerModel";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { LaptopIcon, ServerIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useHeavyQueue } from "../../state/heavyQueue";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FOCUS_RING, formatCpu, GLYPH } from "./ResourceMetrics";
import type { ResourceUsage } from "./resourceUsage.logic";
import { formatMemory, sparklinePoints } from "./statusBar.logic";

const HISTORY_INPUT = { windowMs: 5 * 60_000, bucketMs: 15_000 } as const;
const HISTORY_REFRESH_MS = 15_000;
const TRACE_WIDTH = 36;
const TRACE_HEIGHT = 12;
const MAX_PIPS = 6;

const clampShare = (share: number) => Math.min(1, Math.max(0, share));

/** A reading with its exact words in a tooltip, reachable by keyboard. */
function Reading({
  hint,
  label,
  className,
  children,
}: {
  readonly hint: ReactNode;
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={label}
            className={cn(
              "flex cursor-default items-center gap-1.5 rounded-sm",
              FOCUS_RING,
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-xs">
        {hint}
      </TooltipPopup>
    </Tooltip>
  );
}

/** A thin bar for a share of a whole; its fill slides on change instead of repainting. */
function Meter({ share, warn }: { readonly share: number | null; readonly warn: boolean }) {
  return (
    <span aria-hidden className="relative h-1 w-9 overflow-hidden rounded-full bg-foreground/12">
      {share === null ? null : (
        <span
          data-warn={warn ? "" : undefined}
          className={cn(
            "absolute inset-0 origin-left rounded-full transition-transform duration-500 ease-out motion-reduce:transition-none",
            warn ? "bg-warning" : "bg-foreground/50",
          )}
          style={{ transform: `scaleX(${clampShare(share)})` }}
        />
      )}
    </span>
  );
}

function Trace({
  label,
  values,
}: {
  readonly label: string;
  readonly values: ReadonlyArray<number>;
}) {
  return values.length < 2 ? (
    <span aria-hidden className="w-9" />
  ) : (
    <svg
      role="img"
      aria-label={label}
      width={TRACE_WIDTH}
      height={TRACE_HEIGHT}
      className="shrink-0 text-muted-foreground/80"
    >
      <polyline
        points={sparklinePoints(values, TRACE_WIDTH, TRACE_HEIGHT)}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </svg>
  );
}

const VALUE = "w-11 text-right text-2xs tabular-nums";
const UNIT = "w-6 text-3xs text-muted-foreground";

function Gauge({
  share,
  value,
  unit,
  warn,
  hint,
}: {
  readonly share: number | null;
  readonly value: string;
  readonly unit?: string;
  readonly warn: boolean;
  readonly hint: ReactNode;
}) {
  return (
    <Reading hint={hint}>
      <Meter share={share} warn={warn} />
      <span className={cn(VALUE, warn ? "text-warning-foreground" : "text-foreground/90")}>
        {value}
      </span>
      <span className={UNIT}>{unit}</span>
    </Reading>
  );
}

/** Running jobs against slots, as pips while they fit and always as "1/3". */
function Slots({
  running,
  slots,
  hint,
}: {
  readonly running: number;
  readonly slots: number;
  readonly hint: string;
}) {
  return (
    <Reading hint={hint} className="justify-end gap-1">
      {slots > MAX_PIPS ? null : (
        <span aria-hidden className="flex gap-0.5">
          {Array.from({ length: slots }, (_, index) => (
            <span
              key={index}
              className={cn(
                "size-1.5 rounded-full transition-colors duration-300",
                index < running ? "bg-success" : "bg-foreground/15",
              )}
            />
          ))}
        </span>
      )}
      <span aria-label={hint} className="text-2xs tabular-nums text-muted-foreground">
        {running}/{slots}
      </span>
    </Reading>
  );
}

function MachineName({
  Icon,
  name,
  status,
}: {
  readonly Icon: typeof LaptopIcon;
  readonly name: string;
  readonly status?: { readonly dot: string; readonly text: string; readonly hint: string };
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={GLYPH}>
        <Icon aria-hidden />
      </span>
      <span className="truncate text-xs font-medium text-foreground/90">{name}</span>
      {status === undefined ? null : (
        <Reading hint={status.hint} label={`${name} ${status.text}`}>
          <span className={cn("size-1.5 shrink-0 rounded-full", status.dot)} />
        </Reading>
      )}
    </span>
  );
}

const LINUX_STATUS = (online: boolean | null) =>
  online === null
    ? { text: "checking", dot: "bg-muted-foreground/60" }
    : online
      ? { text: "online", dot: "bg-success" }
      : { text: "offline", dot: "bg-destructive" };

/** T3's own history, refreshed while the bar shows it. */
function useT3History(environmentId: EnvironmentId) {
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const history = useEnvironmentQuery(
    canRead
      ? serverEnvironment.resourceTelemetryHistory({ environmentId, input: HISTORY_INPUT })
      : null,
  );
  const { refresh } = history;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that re-reads server-retained history while the popover shows it
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, HISTORY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  return history.data?.buckets ?? [];
}

/**
 * This Mac and, while the Runner reports it, Linux: CPU, free memory and slots per machine. A
 * condition that holds the queue colours the gauge it is about, worded in that gauge's tooltip.
 * The Mac's readings come from the queue's own reading when it has one, so a warning always
 * matches the number beside it.
 */
export function MachineBar({
  environmentId,
  t3,
}: {
  readonly environmentId: EnvironmentId;
  /** Everything T3 runs, from the same telemetry as the sections below. */
  readonly t3: ResourceUsage | null;
}) {
  const state = useHeavyQueue(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const host = useEnvironmentQuery(
    canRead && state.machine === null
      ? serverEnvironment.hostResources({ environmentId, input: {} })
      : null,
  ).data;
  const buckets = useT3History(environmentId);
  const summaries = machineSummaries(state);
  const work = heavyWork(state, []);
  const reading =
    state.machine !== null
      ? {
          cpuPercent: (state.machine.busyCores / Math.max(1, state.machine.cpuCount)) * 100,
          detail: `${state.machine.busyCores.toFixed(1)} of ${state.machine.cpuCount} cores busy`,
          free: state.machine.availableMemoryBytes,
          total: state.machine.totalMemoryBytes,
        }
      : host === null || host === undefined || host.cpuUtilization == null
        ? null
        : {
            cpuPercent: host.cpuUtilization * 100,
            detail: `${host.cpuCount} cores`,
            free: host.availableMemoryBytes,
            total: host.totalMemoryBytes,
          };
  const gauge = macNoteGauge(state);
  const note = summaries.mac.note;
  const warning = (on: "cpu" | "memory") => (gauge === on && note !== null ? note : null);
  const cpuWarning = warning("cpu");
  const memoryWarning = warning("memory");
  const macRunning = work.mac.running.length;
  const linux = state.linux;
  const linuxRunning = work.linux.running.length;
  return (
    <div
      role="group"
      aria-label="Machines"
      className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
    >
      <MachineName Icon={LaptopIcon} name="This Mac" />
      <Gauge
        share={reading === null ? null : reading.cpuPercent / 100}
        value={reading === null ? "--" : `${Math.round(reading.cpuPercent)}%`}
        warn={cpuWarning !== null}
        hint={
          reading === null
            ? "No CPU reading yet"
            : `CPU ${Math.round(reading.cpuPercent)}% · ${reading.detail}${cpuWarning === null ? "" : ` · ${cpuWarning}`}`
        }
      />
      <Gauge
        share={reading === null || reading.total <= 0 ? null : 1 - reading.free / reading.total}
        value={reading === null ? "--" : formatFreeMemory(reading.free)}
        unit="free"
        warn={memoryWarning !== null}
        hint={
          reading === null
            ? "No memory reading yet"
            : `${formatFreeMemory(reading.free)} free of ${formatFreeMemory(reading.total)}${memoryWarning === null ? "" : ` · ${memoryWarning}`}`
        }
      />
      {state.enabled ? (
        <Slots
          running={macRunning}
          slots={state.maxRunning}
          hint={`${macRunning} of ${state.maxRunning} running on this Mac${gauge === null && note !== null ? ` · ${note}` : ""}`}
        />
      ) : (
        <Reading hint={note ?? ""} className="justify-end">
          <span className="text-2xs text-muted-foreground">Off</span>
        </Reading>
      )}

      {t3 === null ? null : (
        <>
          <Reading hint="T3 Code and the agents, terminals and devices it runs. Lines show the last 5 minutes.">
            <span className="truncate pl-6 text-2xs text-muted-foreground">T3 total</span>
          </Reading>
          <span className="flex items-center gap-1.5">
            <Trace label="T3 CPU, last 5 minutes" values={buckets.map((b) => b.avgCpuPercent)} />
            <span className={cn(VALUE, "text-muted-foreground")}>
              {formatCpu(
                reading === null ? t3.cpuPercent : Math.min(t3.cpuPercent, reading.cpuPercent),
              )}
            </span>
            <span className={UNIT} />
          </span>
          <span className="flex items-center gap-1.5">
            <Trace label="T3 memory, last 5 minutes" values={buckets.map((b) => b.maxRssBytes)} />
            <span className={cn(VALUE, "text-muted-foreground")}>{formatMemory(t3.rssBytes)}</span>
            <span className={UNIT} />
          </span>
          <span />
        </>
      )}

      {linux === null ? null : (
        <>
          <MachineName
            Icon={ServerIcon}
            name="Linux"
            status={{
              ...LINUX_STATUS(linux.online),
              hint: linux.online === true ? `${linux.host} · online` : linuxLine(linux),
            }}
          />
          {linux.online === true ? (
            <>
              <Gauge
                share={
                  linux.load1 === null || linux.cpuCount === null
                    ? null
                    : linux.load1 / Math.max(1, linux.cpuCount)
                }
                value={
                  linux.load1 === null || linux.cpuCount === null
                    ? "--"
                    : `${Math.round((linux.load1 / Math.max(1, linux.cpuCount)) * 100)}%`
                }
                warn={false}
                hint={
                  linux.load1 === null
                    ? "No load reading yet"
                    : `Load ${linux.load1.toFixed(1)}${linux.cpuCount === null ? "" : ` on ${linux.cpuCount} cores`}`
                }
              />
              <Gauge
                share={
                  linux.availableMemoryBytes === null ||
                  linux.totalMemoryBytes === null ||
                  linux.totalMemoryBytes <= 0
                    ? null
                    : 1 - linux.availableMemoryBytes / linux.totalMemoryBytes
                }
                value={
                  linux.availableMemoryBytes === null
                    ? "--"
                    : formatFreeMemory(linux.availableMemoryBytes)
                }
                unit="free"
                warn={false}
                hint={
                  linux.availableMemoryBytes === null
                    ? "No memory reading yet"
                    : `${formatFreeMemory(linux.availableMemoryBytes)} free${linux.totalMemoryBytes === null ? "" : ` of ${formatFreeMemory(linux.totalMemoryBytes)}`}`
                }
              />
            </>
          ) : (
            <Reading hint={linuxLine(linux)} className="col-span-2 min-w-0">
              <span
                className={cn(
                  "truncate text-2xs",
                  linux.online === false ? "text-destructive-foreground" : "text-muted-foreground",
                )}
              >
                {/* The error goes in the tooltip: a long one would starve the names' column. */}
                {linux.online === false ? "Offline" : "Checking…"}
              </span>
            </Reading>
          )}
          <Slots
            running={linuxRunning}
            slots={linux.slots}
            hint={`${linuxRunning} of ${linux.slots} running on Linux${state.enabled && state.paused ? " · paused" : ""}`}
          />
        </>
      )}
    </div>
  );
}
