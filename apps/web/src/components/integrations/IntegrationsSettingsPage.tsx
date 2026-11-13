import type { EnvironmentId, IntegrationsState } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useAssistantEntries } from "../../state/assistants";
import { useEnvironmentProviders } from "../../state/environments";
import {
  useIntegrationActions,
  useIntegrationsEnvironmentIds,
  useIntegrationsState,
} from "../../state/integrations";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { SettingsPageContainer } from "../settings/settingsLayout";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { Spinner } from "../ui/spinner";
import { IntegrationsDirectory } from "./IntegrationsDirectory";

function EnvironmentIntegrations(props: {
  readonly environmentId: EnvironmentId;
  readonly state: IntegrationsState;
}) {
  const navigate = useNavigate();
  const actions = useIntegrationActions(props.environmentId);
  const assistants = useAssistantEntries()
    .active.filter((entry) => entry.environmentId === props.environmentId)
    .map((entry) => entry.assistant);
  const providers = deriveProviderInstanceEntries(
    useEnvironmentProviders().get(props.environmentId) ?? EMPTY_SERVER_PROVIDERS,
  )
    .filter((entry) => entry.enabled)
    .map((entry) => ({ displayName: entry.displayName, driverKind: entry.driverKind }));
  return (
    <IntegrationsDirectory
      state={props.state}
      actions={actions}
      assistants={assistants}
      providers={providers}
      onCustomServers={() =>
        void navigate({
          to: "/settings/providers",
          hash: "mcp-servers",
          hashScrollIntoView: false,
          state: { settingsTargetHighlight: true },
        })
      }
      onChooseAssistants={() => void navigate({ to: "/settings/assistants", hash: "" })}
    />
  );
}

/** Settings → Integrations for the environment the settings scope selects. */
export function IntegrationsSettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const state = useIntegrationsState(environmentId);
  const supported = useIntegrationsEnvironmentIds().some((id) => id === environmentId);
  return (
    <SettingsPageContainer>
      {environmentId === null || state === null ? (
        supported ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : null
      ) : (
        <EnvironmentIntegrations key={environmentId} environmentId={environmentId} state={state} />
      )}
    </SettingsPageContainer>
  );
}
