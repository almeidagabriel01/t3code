import {
  linkedMachineRow,
  machineBar,
  type MachineBarRow,
  type MachineGauge as MachineGaugeModel,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import {
  AuthAccessReadScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { LaptopIcon, ServerIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useHeavyQueue } from "../../state/heavyQueue";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FOCUS_RING, GLYPH } from "./ResourceMetrics";
import {
  formatCpu,
  formatMemory,
  type ResourceUsage,
} from "@t3tools/client-runtime/state/resourceTree";
import { sparklinePoints } from "./statusBar.logic";

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

function MachineGauge({
  gauge,
  unit,
}: {
  readonly gauge: MachineGaugeModel | null;
  readonly unit?: string;
}) {
  return gauge === null ? null : (
    <Gauge
      share={gauge.share}
      value={gauge.value}
      {...(unit === undefined ? {} : { unit })}
      warn={gauge.warn}
      hint={gauge.hint}
    />
  );
}

function MachineSlots({ row }: { readonly row: Pick<MachineBarRow, "slots" | "queueOff"> }) {
  return row.slots === null && row.queueOff === null ? (
    <span />
  ) : row.slots === null ? (
    <Reading hint={row.queueOff ?? ""} className="justify-end">
      <span className="text-2xs text-muted-foreground">Off</span>
    </Reading>
  ) : (
    <Slots running={row.slots.running} slots={row.slots.slots} hint={row.slots.hint} />
  );
}

const LINUX_STATUS = (online: boolean | null) =>
  online === null
    ? { text: "checking", dot: "bg-muted-foreground/60" }
    : online
      ? { text: "online", dot: "bg-success" }
      : { text: "offline", dot: "bg-destructive" };

/** Linux or a linked environment: live gauges, or why there are none. */
function RemoteMachine({
  name,
  row,
  activity = null,
}: {
  readonly name: string;
  readonly row: Omit<MachineBarRow, "runner">;
  readonly activity?: string | null;
}) {
  return (
    <>
      <MachineName
        Icon={ServerIcon}
        name={name}
        status={{ ...LINUX_STATUS(row.online), hint: row.statusHint ?? "" }}
      />
      {row.offline === null ? (
        <>
          <MachineGauge gauge={row.cpu} />
          <MachineGauge gauge={row.memory} unit="free" />
        </>
      ) : (
        <Reading hint={row.offline.hint} className="col-span-2 min-w-0">
          <span
            className={cn(
              "truncate text-2xs",
              row.online === false ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {/* The error goes in the tooltip: a long one would starve the names' column. */}
            {row.offline.text}
          </span>
        </Reading>
      )}
      <MachineSlots row={row} />
      {activity === null ? null : (
        <span className="col-span-4 truncate pl-6 text-2xs text-muted-foreground">{activity}</span>
      )}
    </>
  );
}

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
 * This Mac, Linux while the Runner reports it, and each linked environment: CPU, free memory and
 * slots per machine. A condition that holds the queue colours the gauge it is about, worded in that
 * gauge's tooltip.
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
  // Read even while the queue has a sample, so the Mac row is live the moment that sample ages out.
  const host = useEnvironmentQuery(
    canRead ? serverEnvironment.hostResources({ environmentId, input: {} }) : null,
  );
  const buckets = useT3History(environmentId);
  const { mac, linux } = machineBar(state, host.data, host.error !== null);
  const canReadLinks = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const linkedData = useEnvironmentQuery(
    canRead && canReadLinks
      ? serverEnvironment.linkedEnvironmentResources({ environmentId, input: {} })
      : null,
  ).data;
  const now = useNowMinuteMs();
  const linked = (linkedData ?? []).map((entry) => linkedMachineRow(entry, now));
  const macCpuPercent = mac.cpu?.share == null ? null : mac.cpu.share * 100;
  return (
    <div
      role="group"
      aria-label="Machines"
      className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
    >
      <MachineName Icon={LaptopIcon} name="This Mac" />
      <MachineGauge gauge={mac.cpu} />
      <MachineGauge gauge={mac.memory} unit="free" />
      <MachineSlots row={mac} />

      {t3 === null ? null : (
        <>
          <Reading hint="T3 Code and the agents, terminals and devices it runs. Lines show the last 5 minutes.">
            <span className="truncate pl-6 text-2xs text-muted-foreground">T3 total</span>
          </Reading>
          <span className="flex items-center gap-1.5">
            <Trace label="T3 CPU, last 5 minutes" values={buckets.map((b) => b.avgCpuPercent)} />
            <span className={cn(VALUE, "text-muted-foreground")}>
              {formatCpu(
                macCpuPercent === null ? t3.cpuPercent : Math.min(t3.cpuPercent, macCpuPercent),
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

      {linux === null ? null : <RemoteMachine name="Linux" row={linux} />}

      {linked.map((row) => (
        <RemoteMachine key={row.environmentId} name={row.name} row={row} activity={row.activity} />
      ))}
    </div>
  );
}
