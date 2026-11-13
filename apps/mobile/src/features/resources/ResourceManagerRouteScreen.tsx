import { useIsFocused } from "@react-navigation/native";
import { heavyWork, heavyWorkItems } from "@t3tools/client-runtime/state/heavyQueueModel";
import { withArrivedKeys } from "@t3tools/client-runtime/list-order";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  addUsage,
  environmentResourceTree,
  orderResourceTree,
  resourceTreeKeys,
  runningTerminals,
  toMachineShare,
  type ResourceSort,
} from "@t3tools/client-runtime/state/resourceTree";
import { AuthDiagnosticsReadScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useHeavyCommandsState, useHeavyQueueState } from "../../state/heavyQueue";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { HeavyCommandRows, HeavyWorkSection } from "./HeavyWork";
import { MachineBar } from "./MachineBar";
import {
  DeviceAndAppSections,
  DeviceRows,
  ProjectSections,
  RESOURCE_SORT_LABEL,
  sumUsage,
  usageText,
  type ResourceThreadInfo,
} from "./ProcessSections";

const UNATTRIBUTED = "Unattributed";
const SORTS: ReadonlyArray<ResourceSort> = ["name", "cpu", "memory"];

/**
 * The order rows had at the first sample or the last sort change, so a row never moves under a
 * finger as samples arrive. Rows that appear later join at the end and then hold their place.
 * Before the first sample nothing holds: terminals load first, with no usage to rank them by.
 */
function useHeldOrder(
  keys: ReadonlyArray<string>,
  sort: ResourceSort,
  live: boolean,
): ReadonlyArray<string> {
  const [held, setHeld] = useState<{
    readonly sort: ResourceSort;
    readonly order: ReadonlyArray<string> | null;
  }>({ sort, order: null });
  const base = held.sort === sort ? held.order : null;
  const order = live ? (withArrivedKeys(base, keys) ?? keys) : null;
  if (held.sort !== sort || order !== held.order) setHeld({ sort, order });
  return order ?? keys;
}

/**
 * One environment's machines and what runs on them: Heavy work, projects, devices, T3 Code, then
 * what runs outside T3. Mounted only while the screen is focused, since telemetry and the heavy
 * commands feed sample processes while subscribed.
 */
function EnvironmentResources(props: {
  readonly environmentId: EnvironmentId;
  /** Names the environment when several are connected. */
  readonly label: string | null;
  readonly sort: ResourceSort;
}) {
  const { environmentId } = props;
  const state = useHeavyQueueState(environmentId);
  const { commands, cpuCount } = useHeavyCommandsState(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const telemetry = useEnvironmentQuery(
    canRead ? serverEnvironment.resourceTelemetry({ environmentId, input: {} }) : null,
  ).data;
  const snapshot = telemetry == null ? null : toMachineShare(telemetry);
  const terminals = runningTerminals(
    useKnownTerminalSessions({ environmentId, threadId: null }).sessions ?? [],
  );
  const threads = new Map<string, ResourceThreadInfo>(
    useThreadShells()
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => [
        thread.id,
        {
          projectId: thread.projectId,
          title: thread.title,
          working: threadRuntimeIsActive(thread.runtime),
        },
      ]),
  );
  const projects = new Map(
    useProjects()
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [String(project.id), project.title]),
  );
  const ranked = environmentResourceTree({
    snapshot,
    terminals,
    sort: props.sort,
    projectOfThread: (threadId) => threads.get(threadId)?.projectId ?? null,
    projectTitle: (projectKey) =>
      projectKey === null ? UNATTRIBUTED : (projects.get(projectKey) ?? UNATTRIBUTED),
    threadTitle: (threadId) => threads.get(threadId)?.title || "Agent",
  });
  const tree = orderResourceTree(
    ranked,
    useHeldOrder(resourceTreeKeys(ranked), props.sort, snapshot !== null),
  );
  const live = snapshot !== null;
  const cores = snapshot?.cpuCount ?? 1;
  const work = heavyWork(state, commands);
  const outsideDevices = tree.devices.filter((device) => device.outside);
  const outsideCount = outsideDevices.length + work.detached.length;
  const outsideUsage = work.detached.reduce(
    (sum, command) =>
      command.cpu === undefined || command.memory === undefined
        ? sum
        : addUsage(sum, {
            cpuPercent: (command.cpu / Math.max(1, cpuCount)) * 100,
            rssBytes: command.memory,
            processCount: 1,
          }),
    sumUsage(outsideDevices),
  );
  const nothing =
    heavyWorkItems(work).length === 0 &&
    tree.projects.length === 0 &&
    tree.devices.every((device) => device.outside);
  return (
    <View className="gap-6">
      <SettingsSection {...(props.label === null ? {} : { title: props.label })}>
        <MachineBar
          environmentId={environmentId}
          state={state}
          t3={
            snapshot === null
              ? null
              : {
                  cpuPercent: snapshot.groups.allT3.currentCpuPercent,
                  rssBytes: snapshot.groups.allT3.currentRssBytes,
                  processCount: snapshot.groups.allT3.processCount,
                }
          }
        />
      </SettingsSection>
      {nothing ? (
        <SettingsSection>
          <ListRowLayout icon="checkmark" label="Nothing running right now" />
        </SettingsSection>
      ) : null}
      <HeavyWorkSection
        environmentId={environmentId}
        state={state}
        commands={commands}
        cpuCount={cpuCount}
      />
      <ProjectSections
        environmentId={environmentId}
        tree={tree}
        live={live}
        cores={cores}
        terminals={terminals}
        threadInfo={(threadId) => threads.get(threadId)}
      />
      <DeviceAndAppSections environmentId={environmentId} tree={tree} live={live} cores={cores} />
      {outsideCount === 0 ? null : (
        <SettingsSection
          title="Outside T3"
          trailing={
            <Text textRole="footnote" className="text-foreground-muted tabular-nums">
              {`${outsideCount} · ${usageText(outsideUsage)}`}
            </Text>
          }
        >
          {outsideDevices.length === 0 ? null : (
            <DeviceRows
              environmentId={environmentId}
              devices={outsideDevices}
              outside
              cores={cores}
            />
          )}
          <HeavyCommandRows
            environmentId={environmentId}
            commands={work.detached}
            cpuCount={cpuCount}
          />
        </SettingsSection>
      )}
    </View>
  );
}

export function ResourceManagerRouteScreen() {
  const focused = useIsFocused();
  const { environments } = useEnvironments();
  const connected = environments.filter(({ connection }) => connection.phase === "connected");
  const insets = useSafeAreaInsets();
  const [sort, setSort] = useState<ResourceSort>("memory");
  return (
    <SettingsScreen
      title="Resource Manager"
      menus={[
        {
          title: "Sort",
          icon: "arrow.up.arrow.down",
          items: SORTS.map((option) => ({
            id: option,
            title: RESOURCE_SORT_LABEL[option],
            selected: sort === option,
            onPress: () => setSort(option),
          })),
        },
      ]}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-8 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {focused
          ? connected.map((environment) => (
              <EnvironmentResources
                key={environment.environmentId}
                environmentId={environment.environmentId}
                label={connected.length > 1 ? environment.label : null}
                sort={sort}
              />
            ))
          : null}
      </ScrollView>
    </SettingsScreen>
  );
}
