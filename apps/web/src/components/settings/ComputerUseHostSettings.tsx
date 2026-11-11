import {
  COMPUTER_USE_CAPABILITY_LABELS,
  COMPUTER_USE_HOST_INTRO,
  COMPUTER_USE_HOST_NOT_REPORTED,
  computerUseCapabilityStateLabel,
  computerUseHostLabel,
  isComputerUseHostOs,
} from "@t3tools/client-runtime/state/mac-permissions";
import type { ComputerUseCapabilityState, EnvironmentId } from "@t3tools/contracts";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const STATE_VARIANTS = {
  available: "success",
  consent: "info",
  limited: "warning",
  unavailable: "outline",
} as const satisfies Record<ComputerUseCapabilityState, string>;

function HostSection(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly searchable: boolean;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.macPermissions({
      environmentId: props.environmentId,
      input: { automation: false },
    }),
  );
  const anchor = props.searchable ? searchableSetting("computer-use") : {};
  const host = query.data?.host;
  return (
    <SettingsSection title={props.title}>
      {query.data === null ? (
        <SettingsRow
          {...anchor}
          title={query.error === null ? "Checking..." : "Could not read this computer"}
          description={query.error ?? "Reading what agents can do on this computer."}
        />
      ) : host === undefined ? (
        <SettingsRow
          {...anchor}
          title="Not reported"
          description={COMPUTER_USE_HOST_NOT_REPORTED}
        />
      ) : (
        <>
          <SettingsRow
            {...anchor}
            title={computerUseHostLabel(host)}
            description={COMPUTER_USE_HOST_INTRO}
          />
          {host.capabilities.map((capability) => (
            <SettingsRow
              key={capability.key}
              title={COMPUTER_USE_CAPABILITY_LABELS[capability.key]}
              description={capability.detail}
              status={
                <Badge variant={STATE_VARIANTS[capability.state]}>
                  {computerUseCapabilityStateLabel(capability.state)}
                </Badge>
              }
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}

/** Every connected Windows or Linux host, this app's own server first. */
export function ComputerUseHostSettingsPanel() {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const hosts = environments
    .filter(
      (environment) =>
        isComputerUseHostOs(environment.serverConfig?.environment.platform.os) &&
        environment.connection.phase === "connected",
    )
    .toSorted(
      (a, b) => Number(b.environmentId === primaryId) - Number(a.environmentId === primaryId),
    );
  return (
    <SettingsPageContainer>
      {hosts.length === 0 ? (
        <SettingsSection title="Computer use">
          <SettingsRow
            {...searchableSetting("computer-use")}
            title="Not available"
            description="This page reports what agents can do on a connected Windows or Linux computer. A Mac has its own Mac permissions page."
          />
        </SettingsSection>
      ) : (
        hosts.map((environment, index) => (
          <HostSection
            key={environment.environmentId}
            environmentId={environment.environmentId}
            title={hosts.length > 1 ? `Computer use · ${environment.label}` : "Computer use"}
            searchable={index === 0}
          />
        ))
      )}
    </SettingsPageContainer>
  );
}
