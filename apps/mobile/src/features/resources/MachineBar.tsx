import {
  formatCpu,
  formatMemory,
  type ResourceUsage,
} from "@t3tools/client-runtime/state/resourceTree";
import {
  linkedMachineRow,
  machineBar,
  type MachineBarRow,
  type MachineGauge,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import {
  AuthAccessReadScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type HeavyQueueState,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useNowMinuteMs } from "../../lib/clock";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Glyph, MACHINE } from "./HeavyWork";

const MAX_PIPS = 6;
const clampShare = (share: number) => Math.min(1, Math.max(0, share));

const LINUX_STATUS = (online: boolean | null) =>
  online === null
    ? { text: "checking", dot: "bg-foreground-muted" }
    : online
      ? { text: "online", dot: "bg-adaptive-emerald-600-400" }
      : { text: "offline", dot: "bg-danger" };

/** A thin bar for a share of a whole, with its value; warning-coloured when a hold is about it. */
function Gauge(props: {
  readonly icon: AppSymbolName;
  readonly gauge: MachineGauge;
  readonly unit?: string;
}) {
  const { share, value, warn } = props.gauge;
  return (
    <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
      <Glyph name={props.icon} />
      <View className="h-1 w-10 overflow-hidden rounded-full bg-subtle-strong">
        {share === null ? null : (
          <View
            className={`h-full rounded-full ${warn ? "bg-warning" : "bg-foreground-muted"}`}
            style={{ width: `${clampShare(share) * 100}%` }}
          />
        )}
      </View>
      <Text
        textRole="footnote"
        numberOfLines={1}
        className={`shrink tabular-nums ${warn ? "text-warning-foreground" : "text-foreground"}`}
      >
        {value}
        {props.unit === undefined || share === null ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {` ${props.unit}`}
          </Text>
        )}
      </Text>
    </View>
  );
}

function Slots(props: { readonly row: Pick<MachineBarRow, "slots" | "queueOff"> }) {
  const { slots } = props.row;
  if (slots === null && props.row.queueOff === null) return null;
  if (slots === null)
    return (
      <Text textRole="footnote" className="text-foreground-muted">
        Off
      </Text>
    );
  return (
    <View className="flex-row items-center gap-1.5">
      {slots.slots > MAX_PIPS ? null : (
        <View className="flex-row gap-1">
          {Array.from({ length: slots.slots }, (_, index) => (
            <View
              key={index}
              className={`size-1.5 rounded-full ${index < slots.running ? "bg-adaptive-emerald-600-400" : "bg-subtle-strong"}`}
            />
          ))}
        </View>
      )}
      <Text textRole="footnote" className="text-foreground-muted tabular-nums">
        {slots.running}/{slots.slots}
      </Text>
    </View>
  );
}

/** One machine: name, slots and its two gauges; a press shows the exact readings under it. */
const T3_TOTAL_HINT = "T3 Code and the agents, terminals and devices it runs.";

function MachineRow(props: {
  readonly row: Omit<MachineBarRow, "runner">;
  readonly name: string;
  readonly icon: AppSymbolName;
  /** Linux and linked environments show their connection; This Mac is always here. */
  readonly remote: boolean;
  readonly hint?: string | null;
  readonly children?: ReactNode;
}) {
  const { row, name, icon } = props;
  const [open, setOpen] = useState(false);
  const status = props.remote ? LINUX_STATUS(row.online) : null;
  const hints = [
    row.statusHint,
    row.cpu?.hint,
    row.memory?.hint,
    row.offline !== null && row.offline.hint !== row.statusHint ? row.offline.hint : null,
    row.slots?.hint ?? row.queueOff,
    props.hint,
  ].filter((hint): hint is string => hint !== null && hint !== undefined && hint !== "");
  const warned = row.cpu?.warn === true || row.memory?.warn === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        name,
        status?.text,
        row.cpu === null ? null : `CPU ${row.cpu.value}`,
        row.memory === null ? null : `${row.memory.value} free`,
        row.slots !== null
          ? `${row.slots.running} of ${row.slots.slots} running`
          : row.queueOff === null
            ? null
            : "Off",
        warned ? "warning" : null,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityState={{ expanded: open }}
      accessibilityHint={open ? "Hides the readings" : "Shows the readings"}
      onPress={() => setOpen((value) => !value)}
      className="gap-2 px-4 py-3 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        <SymbolView
          name={icon}
          size={15}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text textRole="footnote" className="font-semibold text-foreground">
          {name}
        </Text>
        {status === null ? null : <View className={`size-2 rounded-full ${status.dot}`} />}
        <View className="flex-1" />
        <Slots row={row} />
      </View>
      {row.offline !== null ? (
        <Text
          textRole="footnote"
          numberOfLines={1}
          className={`pl-6 ${row.online === false ? "text-danger-foreground" : "text-foreground-muted"}`}
        >
          {row.offline.text}
        </Text>
      ) : (
        <View className="flex-row items-center gap-4 pl-6">
          {row.cpu === null ? null : (
            <Gauge icon="gauge.with.dots.needle.50percent" gauge={row.cpu} />
          )}
          {row.memory === null ? null : (
            <Gauge icon="internaldrive" gauge={row.memory} unit="free" />
          )}
        </View>
      )}
      {props.children}
      {open ? (
        <View className="gap-1 pl-6">
          {hints.map((hint) => (
            <Text key={hint} textRole="footnote" selectable className="text-foreground-muted">
              {hint}
            </Text>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

/** This Mac, Linux while the Runner reports it, and each linked environment: CPU, free memory and slots. */
export function MachineBar(props: {
  readonly environmentId: EnvironmentId;
  readonly state: HeavyQueueState;
  /** What T3 Code and everything it runs use, shown under This Mac. */
  readonly t3?: ResourceUsage | null;
}) {
  const { environmentId, state } = props;
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  // Read even while the queue has a sample, so the Mac row is live the moment that sample ages out.
  const host = useEnvironmentQuery(
    canRead ? serverEnvironment.hostResources({ environmentId, input: {} }) : null,
  );
  const { mac, linux } = machineBar(state, host.data, host.error !== null);
  const canReadLinks = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const linkedData = useEnvironmentQuery(
    canRead && canReadLinks
      ? serverEnvironment.linkedEnvironmentResources({ environmentId, input: {} })
      : null,
  ).data;
  const now = useNowMinuteMs();
  const linked = (linkedData ?? []).map((entry) => linkedMachineRow(entry, now));
  const { t3 } = props;
  const macCpuPercent = mac.cpu?.share == null ? null : mac.cpu.share * 100;
  return (
    <View accessibilityRole="list" accessibilityLabel="Machines">
      <MachineRow
        {...MACHINE.mac}
        remote={false}
        row={mac}
        hint={t3 == null ? null : T3_TOTAL_HINT}
      >
        {t3 == null ? null : (
          <Text
            textRole="footnote"
            numberOfLines={1}
            className="pl-6 text-foreground-muted tabular-nums"
          >
            {`T3 total · ${formatCpu(macCpuPercent === null ? t3.cpuPercent : Math.min(t3.cpuPercent, macCpuPercent))} · ${formatMemory(t3.rssBytes)}`}
          </Text>
        )}
      </MachineRow>
      {linux === null ? null : <MachineRow {...MACHINE.linux} remote row={linux} />}
      {linked.map((row) => (
        <MachineRow
          key={row.environmentId}
          name={row.name}
          icon={MACHINE.linux.icon}
          remote
          row={row}
        >
          {row.activity === null ? null : (
            <Text textRole="footnote" numberOfLines={1} className="pl-6 text-foreground-muted">
              {row.activity}
            </Text>
          )}
        </MachineRow>
      ))}
    </View>
  );
}
