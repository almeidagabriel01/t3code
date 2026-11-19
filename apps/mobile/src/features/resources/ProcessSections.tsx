import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import {
  APP_GROUP_LABEL,
  addUsage,
  deviceRowLabel,
  deviceShutdownTargets,
  EMPTY_USAGE,
  formatCpu,
  formatMemory,
  isHeavyProcess,
  type AppProcessGroup,
  type DevicePlatform,
  type DeviceRow,
  type OutsideAppRow,
  type ResourceTree,
  type ResourceUsage,
} from "@t3tools/client-runtime/state/resourceTree";
import { processLabel } from "@t3tools/client-runtime/state/processLabel";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalOperateScope,
  type DeviceShutdownInput,
  type EnvironmentId,
  type ResourceTelemetryProcess,
} from "@t3tools/contracts";
import { useState } from "react";
import { Alert, View } from "react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { RowMenuButton } from "../../components/ui/RowMenuButton";
import { deviceEnvironment } from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { RESOURCE_MANAGER_COPY } from "./resourceManagerCopy";
import { HeavyRow, menuItem, useOpenThread, type Fact } from "./HeavyWork";

const APP_GROUP_ICON: Record<AppProcessGroup, AppSymbolName> = {
  main: "desktopcomputer",
  renderer: "square.on.square",
  server: "server.rack",
  other: "gearshape",
};

const DEVICE_ICON: Record<DevicePlatform, AppSymbolName> = {
  android: "iphone",
  ios: "iphone",
  tools: "wrench.and.screwdriver",
};

export const usageText = (usage: Pick<ResourceUsage, "cpuPercent" | "rssBytes">) =>
  `${formatCpu(usage.cpuPercent)} · ${formatMemory(usage.rssBytes)}`;

export const sumUsage = (rows: ReadonlyArray<{ readonly usage: ResourceUsage }>) =>
  rows.reduce((sum, row) => addUsage(sum, row.usage), EMPTY_USAGE);

const sectionTrailing = (count: number, usage: ResourceUsage | null) => (
  <Text textRole="footnote" className="text-foreground-muted tabular-nums">
    {usage === null ? count : `${count} · ${usageText(usage)}`}
  </Text>
);

const failed = (title: string, result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const failure = squashAtomCommandFailure(result);
  Alert.alert(title, failure instanceof Error ? failure.message : String(failure));
};

const confirmDestructive = (message: string, action: string, onConfirm: () => void) =>
  Alert.alert(message, undefined, [
    { text: "Cancel", style: "cancel" },
    { text: action, style: "destructive", onPress: onConfirm },
  ]);

function ProcessList(props: {
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly cores: number;
}) {
  return (
    <View className="gap-2 pr-4 pb-3 pl-13">
      {props.processes.map((process) => {
        const heavy = isHeavyProcess(process, props.cores);
        return (
          <View key={process.identity.pid} className="flex-row items-start gap-3">
            <View className="min-w-0 flex-1">
              <Text
                textRole="footnote"
                numberOfLines={1}
                className={heavy ? "text-warning-foreground" : "text-foreground"}
              >
                {processLabel(process)}
              </Text>
              <Text
                textRole="caption"
                selectable
                numberOfLines={2}
                className="font-mono text-foreground-muted"
              >
                {`${process.command} · pid ${process.identity.pid}`}
              </Text>
            </View>
            <Text
              textRole="footnote"
              className={`shrink-0 tabular-nums ${heavy ? "text-warning-foreground" : "text-foreground-muted"}`}
            >
              {usageText({ cpuPercent: process.cpuPercent, rssBytes: process.residentBytes })}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** A row of what runs: name and usage; a press shows what it is and its processes. */
function UsageRow(props: {
  readonly icon: AppSymbolName;
  readonly iconLabel: string;
  readonly label: string;
  readonly suffix?: string | null;
  readonly usage: ResourceUsage | null;
  readonly processes?: ReadonlyArray<ResourceTelemetryProcess> | undefined;
  readonly cores: number;
  readonly facts: ReadonlyArray<Fact>;
  readonly actions: ReadonlyArray<MenuAction>;
  readonly onAction?: (id: string) => void;
}) {
  const processes = props.processes ?? [];
  return (
    <HeavyRow
      name={props.label}
      icon={props.icon}
      iconLabel={props.iconLabel}
      project={undefined}
      state={props.usage === null ? "" : usageText(props.usage)}
      secondLine={props.suffix ?? undefined}
      facts={props.facts}
      details={
        processes.length === 0 ? null : <ProcessList processes={processes} cores={props.cores} />
      }
      menu={
        props.actions.length === 0 ? null : (
          <RowMenuButton
            label={`Actions for ${props.label}`}
            actions={[...props.actions]}
            onAction={(id) => props.onAction?.(id)}
          />
        )
      }
    />
  );
}

export interface ResourceThreadInfo {
  readonly projectId: string;
  readonly title: string;
  readonly working: boolean;
}

function useCloseTerminal(environmentId: EnvironmentId) {
  const canClose = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const command = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const close = (session: KnownTerminalSession, label: string) =>
    confirmDestructive(
      `Close terminal "${label}" and stop its processes?`,
      "End terminal",
      async () => {
        const result = await command({
          environmentId,
          input: { threadId: session.target.threadId, terminalId: session.target.terminalId },
        });
        failed("Could not close terminal", result);
      },
    );
  return { canClose, close };
}

/** One section per project: its agents and running terminals. */
export function ProjectSections(props: {
  readonly environmentId: EnvironmentId;
  readonly tree: ResourceTree;
  readonly live: boolean;
  readonly cores: number;
  readonly terminals: ReadonlyMap<string, KnownTerminalSession>;
  readonly threadInfo: (threadId: string) => ResourceThreadInfo | undefined;
}) {
  const openThread = useOpenThread(props.environmentId);
  const { canClose, close } = useCloseTerminal(props.environmentId);
  return props.tree.projects.map((project) => (
    <SettingsSection
      key={project.projectKey ?? "unattributed"}
      title={project.title}
      trailing={sectionTrailing(project.rows.length, props.live ? project.usage : null)}
    >
      {project.rows.map((row) => {
        const usage = props.live ? row.usage : null;
        const processes = props.live ? row.processes : undefined;
        const thread: Fact = {
          label: "Thread",
          value: props.threadInfo(row.threadId)?.title || row.name,
          onPress: () => openThread(row.threadId),
        };
        if (row.kind === "agent") {
          const working = props.threadInfo(row.threadId)?.working ?? false;
          return (
            <UsageRow
              key={row.key}
              icon="bubble.left"
              iconLabel="Agent"
              label={row.name}
              suffix={working ? null : "idle"}
              usage={usage}
              processes={processes}
              cores={props.cores}
              facts={
                working
                  ? [thread]
                  : [
                      thread,
                      { label: "Note", value: "Idle agent session, kept open for follow-ups" },
                    ]
              }
              actions={[menuItem("thread", "Open thread", "bubble.left")]}
              onAction={() => openThread(row.threadId)}
            />
          );
        }
        const session = props.terminals.get(row.key);
        const cwd = session?.state.summary?.cwd;
        return (
          <UsageRow
            key={row.key}
            icon="terminal"
            iconLabel="Terminal"
            label={row.name}
            suffix={session?.state.hasRunningSubprocess ? "running" : null}
            usage={usage}
            processes={processes}
            cores={props.cores}
            facts={[
              ...(cwd === undefined || cwd === null
                ? []
                : [{ label: "Folder", value: cwd, mono: true }]),
              thread,
            ]}
            actions={[
              menuItem("thread", "Open thread", "bubble.left"),
              ...(session === undefined
                ? []
                : [
                    {
                      ...menuItem("close", "End terminal", "xmark.circle.fill"),
                      attributes: { disabled: !canClose, destructive: true },
                    },
                  ]),
            ]}
            onAction={(id) => {
              if (id === "thread") openThread(row.threadId);
              else if (id === "close" && session !== undefined) close(session, row.name);
            }}
          />
        );
      })}
    </SettingsSection>
  ));
}

const OUTSIDE_NOTE: Fact = { label: "Note", value: "Runs outside T3, not counted in the T3 total" };

/** The heaviest apps outside T3, helpers summed into their app. */
export function OutsideAppRows(props: {
  readonly rows: ReadonlyArray<OutsideAppRow>;
  readonly cores: number;
}) {
  return props.rows.map((row) => (
    <UsageRow
      key={row.name}
      icon="square.grid.2x2"
      iconLabel="App"
      label={row.name}
      usage={row.usage}
      cores={props.cores}
      facts={[OUTSIDE_NOTE]}
      actions={[]}
    />
  ));
}

/** What runs outside T3 beyond the listed rows: the system, the kernel and small processes. */
export function OtherRow(props: { readonly usage: ResourceUsage; readonly cores: number }) {
  return (
    <UsageRow
      icon="ellipsis"
      iconLabel={RESOURCE_MANAGER_COPY.other.title}
      label={RESOURCE_MANAGER_COPY.other.title}
      usage={props.usage}
      cores={props.cores}
      facts={[OUTSIDE_NOTE]}
      actions={[]}
    />
  );
}

/** Rendered only while devices run, so the device state subscription stays closed otherwise. */
export function DeviceRows(props: {
  readonly environmentId: EnvironmentId;
  readonly devices: ReadonlyArray<DeviceRow>;
  /** Devices running outside T3's process tree, which the T3 total leaves out. */
  readonly outside: boolean;
  readonly cores: number;
}) {
  const { environmentId } = props;
  const state = useEnvironmentQuery(deviceEnvironment.state({ environmentId, input: {} })).data;
  const canShutDown = useAtomValue(deviceEnvironment.shutdown.permissionAtom(environmentId));
  const command = useAtomCommand(deviceEnvironment.shutdown, { reportFailure: false });
  const devices = state?.devices ?? [];
  const localHostIds = new Set<string>(
    (state?.hosts ?? []).flatMap((host) => (host.kind === "local" ? [host.id] : [])),
  );
  const shutDown = (targets: ReadonlyArray<DeviceShutdownInput>, label: string) =>
    confirmDestructive(`Shut down ${label}? Apps running on it stop.`, "Shut down", async () => {
      for (const input of targets) {
        const result = await command({ environmentId, input });
        if (result._tag === "Failure") return failed("Could not shut down device", result);
      }
    });
  return props.devices.map((device) => {
    const targets = deviceShutdownTargets(device, devices, localHostIds);
    const label = deviceRowLabel(device, devices, localHostIds);
    return (
      <UsageRow
        key={device.key}
        icon={DEVICE_ICON[device.platform]}
        iconLabel="Device"
        label={label}
        usage={device.usage}
        processes={device.processes}
        cores={props.cores}
        facts={props.outside ? [OUTSIDE_NOTE] : []}
        actions={
          targets.length === 0
            ? []
            : [
                {
                  ...menuItem("shutdown", "Shut down", "stop.fill"),
                  attributes: { disabled: !canShutDown, destructive: true },
                },
              ]
        }
        onAction={() => shutDown(targets, label)}
      />
    );
  });
}

/** Devices T3 started, then T3 Code's own processes, collapsed until opened as on web. */
export function DeviceAndAppSections(props: {
  readonly environmentId: EnvironmentId;
  readonly tree: ResourceTree;
  readonly live: boolean;
  readonly cores: number;
}) {
  const [appOpen, setAppOpen] = useState(false);
  const devices = props.tree.devices.filter((device) => !device.outside);
  const appUsage = sumUsage(props.tree.app);
  return (
    <>
      {devices.length === 0 ? null : (
        <SettingsSection
          title={RESOURCE_MANAGER_COPY.devices.title}
          trailing={sectionTrailing(devices.length, sumUsage(devices))}
        >
          <DeviceRows
            environmentId={props.environmentId}
            devices={devices}
            outside={false}
            cores={props.cores}
          />
        </SettingsSection>
      )}
      {!props.live ? null : (
        <SettingsSection
          title={RESOURCE_MANAGER_COPY.t3Code.title}
          trailing={sectionTrailing(props.tree.app.length, appUsage)}
          collapsible={{
            expanded: appOpen,
            onToggle: () => setAppOpen((open) => !open),
            summary: `${props.tree.app.length}, ${usageText(appUsage)}`,
          }}
        >
          {props.tree.app.map((row) => (
            <UsageRow
              key={row.group}
              icon={APP_GROUP_ICON[row.group]}
              iconLabel={APP_GROUP_LABEL[row.group]}
              label={`${APP_GROUP_LABEL[row.group]} (${row.usage.processCount})`}
              usage={row.usage}
              processes={row.processes}
              cores={props.cores}
              facts={[]}
              actions={[]}
            />
          ))}
        </SettingsSection>
      )}
    </>
  );
}
