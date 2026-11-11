import {
  COMPUTER_USE_CAPABILITY_LABELS,
  COMPUTER_USE_HOST_INTRO,
  COMPUTER_USE_HOST_NOT_REPORTED,
  computerUseCapabilityStateLabel,
  computerUseHostLabel,
} from "@t3tools/client-runtime/state/mac-permissions";
import type { ComputerUseCapabilityKey, EnvironmentId } from "@t3tools/contracts";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useComputerUseHostEnvironmentIds } from "../../state/macPermissions";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "./components/SettingsScreen";

const CAPABILITY_ICONS: Record<ComputerUseCapabilityKey, AppSymbolName> = {
  elements: "square.grid.2x2",
  screenshot: "camera",
  pointer: "target",
  keyboard: "keyboard",
};

function HostEnvironment(props: {
  readonly environmentId: EnvironmentId;
  readonly title?: string;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.macPermissions({
      environmentId: props.environmentId,
      input: { automation: false },
    }),
  );
  const host = query.data?.host;
  return (
    <ListSection title={props.title ? `This computer · ${props.title}` : "This computer"}>
      {query.data === null ? (
        <ListRowLayout
          icon="arrow.clockwise"
          label={query.error === null ? "Checking..." : "Could not read this computer"}
          description={query.error ?? undefined}
        />
      ) : host === undefined ? (
        <ListRowLayout
          icon="info.circle"
          label="Not reported"
          description={COMPUTER_USE_HOST_NOT_REPORTED}
        />
      ) : (
        <>
          <ListRowLayout
            icon="desktopcomputer"
            label={computerUseHostLabel(host)}
            description={COMPUTER_USE_HOST_INTRO}
          />
          {host.capabilities.map((capability) => (
            <ListRowLayout
              key={capability.key}
              icon={CAPABILITY_ICONS[capability.key]}
              label={COMPUTER_USE_CAPABILITY_LABELS[capability.key]}
              description={capability.detail}
              detail={computerUseCapabilityStateLabel(capability.state)}
            />
          ))}
        </>
      )}
    </ListSection>
  );
}

export function SettingsComputerUseRouteScreen() {
  const environmentIds = useComputerUseHostEnvironmentIds();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Computer use">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text textRole="footnote" className="px-4 text-foreground-muted">
          What agents can do on the Windows or Linux computer that runs T3 Code, and where the
          platform stops them. There are no permissions to grant there.
        </Text>
        {environmentIds.length === 0 ? (
          <EmptyState
            variant="plain"
            title="Computer use is not reported here"
            detail="Connect an environment whose server runs on Windows or Linux. A Mac has its own Mac permissions page."
          />
        ) : (
          environmentIds.map((environmentId) => (
            <HostEnvironment
              key={environmentId}
              environmentId={environmentId}
              title={
                environmentIds.length > 1
                  ? savedConnectionsById[environmentId]?.environmentLabel
                  : undefined
              }
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
