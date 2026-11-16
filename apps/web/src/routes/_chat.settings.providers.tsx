import { createFileRoute } from "@tanstack/react-router";
import {
  CONNECT_ENVIRONMENT_FOR_PROVIDERS,
  reconnectEnvironmentForProviders,
} from "@t3tools/client-runtime/settings-empty-selection";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsServerEnvironmentNotice,
} from "../components/settings/settingsLayout";

function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <SettingsPageContainer>
        <SettingsServerEnvironmentNotice>
          {scope.kind === "environment"
            ? reconnectEnvironmentForProviders(scope.label)
            : CONNECT_ENVIRONMENT_FOR_PROVIDERS}
        </SettingsServerEnvironmentNotice>
      </SettingsPageContainer>
    );
  }
  return (
    <ProviderSettingsPanel
      environmentId={environment.environmentId}
      {...(target.instanceId ? { instanceId: target.instanceId } : {})}
      projectIds={
        scope.kind === "project" || scope.kind === "checkout"
          ? scope.members
              .filter((member) => member.environmentId === environment.environmentId)
              .map((member) => member.id)
          : []
      }
      scoped
    />
  );
}

export const Route = createFileRoute("/_chat/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});
