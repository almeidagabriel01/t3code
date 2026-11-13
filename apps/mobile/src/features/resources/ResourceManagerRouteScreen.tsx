import { useIsFocused } from "@react-navigation/native";
import { heavyWork, heavyWorkItems } from "@t3tools/client-runtime/state/heavyQueueModel";
import type { EnvironmentId } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { useEnvironments } from "../../state/environments";
import { useHeavyCommandsState, useHeavyQueueState } from "../../state/heavyQueue";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { HeavyCommandRows, HeavyWorkSection } from "./HeavyWork";
import { MachineBar } from "./MachineBar";

/**
 * One environment's machines and what runs on them: Heavy work, then what runs outside T3. Mounted
 * only while the screen is focused, since the heavy commands feed samples processes while subscribed.
 */
function EnvironmentResources(props: {
  readonly environmentId: EnvironmentId;
  /** Names the environment when several are connected. */
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const state = useHeavyQueueState(environmentId);
  const { commands, cpuCount } = useHeavyCommandsState(environmentId);
  const work = heavyWork(state, commands);
  const nothing = heavyWorkItems(work).length === 0 && work.detached.length === 0;
  return (
    <View className="gap-6">
      <SettingsSection {...(props.label === null ? {} : { title: props.label })}>
        <MachineBar environmentId={environmentId} state={state} />
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
      {work.detached.length === 0 ? null : (
        <SettingsSection title="Outside T3">
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
  return (
    <SettingsScreen title="Resource Manager">
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
              />
            ))
          : null}
      </ScrollView>
    </SettingsScreen>
  );
}
