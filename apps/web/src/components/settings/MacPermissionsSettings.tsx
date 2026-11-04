import { useAtomValue } from "@effect/atom-react";
import {
  MAC_PERMISSION_ROWS,
  macPermissionStatusLabel,
} from "@t3tools/client-runtime/state/mac-permissions";
import type { EnvironmentId, MacPermissionPane, MacPermissionStatus } from "@t3tools/contracts";
import { AccessibilityIcon, MonitorIcon, WorkflowIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PANE_ICONS: Record<MacPermissionPane, ReactNode> = {
  "screen-recording": <MonitorIcon className="size-3.5" />,
  accessibility: <AccessibilityIcon className="size-3.5" />,
  automation: <WorkflowIcon className="size-3.5" />,
};

const STATUS_VARIANTS = {
  granted: "success",
  denied: "warning",
  unknown: "outline",
} as const satisfies Record<MacPermissionStatus, string>;

/** The Mac that runs the agents' tools: this app's own server when it is a Mac, else the first connected Mac. */
function useMacEnvironmentId(): EnvironmentId | null {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const macs = environments.filter(
    (environment) =>
      environment.serverConfig?.environment.platform.os === "darwin" &&
      environment.connection.phase === "connected",
  );
  return (macs.find((mac) => mac.environmentId === primaryId) ?? macs[0])?.environmentId ?? null;
}

function MacPermissionsSections({ environmentId }: { readonly environmentId: EnvironmentId }) {
  // Reading Automation can make macOS prompt, so only Check again reads it, never opening the page.
  const [automationChecked, setAutomationChecked] = useState(false);
  const query = useEnvironmentQuery(
    serverEnvironment.macPermissions({ environmentId, input: { automation: automationChecked } }),
  );
  const canOpen = useAtomValue(serverEnvironment.openMacSettings.permissionAtom(environmentId));
  const openSettings = useAtomCommand(serverEnvironment.openMacSettings);
  const permissions = query.data;
  return (
    <SettingsSection
      title="Mac permissions"
      headerAction={
        <Button
          variant="outline"
          size="compact"
          disabled={query.isPending}
          onClick={automationChecked ? query.refresh : () => setAutomationChecked(true)}
        >
          {query.isPending ? "Checking..." : "Check again"}
        </Button>
      }
    >
      {permissions === null ? (
        <SettingsRow
          {...searchableSetting("mac-permissions")}
          title={query.error === null ? "Checking..." : "Could not check the permissions"}
          description={
            query.error ?? "Reading what macOS lets T3 Code do. A macOS prompt may appear."
          }
        />
      ) : (
        MAC_PERMISSION_ROWS.map((row, index) => (
          <SettingsRow
            key={row.key}
            {...(index === 0 ? searchableSetting("mac-permissions") : {})}
            title={row.label}
            description={row.description}
            status={
              <Badge variant={STATUS_VARIANTS[permissions[row.key]]}>
                {macPermissionStatusLabel(
                  permissions[row.key],
                  row.key !== "automation" || automationChecked,
                )}
              </Badge>
            }
            control={
              <Button
                variant="outline"
                size="compact"
                disabled={!canOpen}
                onClick={() => void openSettings({ environmentId, input: { pane: row.pane } })}
              >
                {PANE_ICONS[row.pane]}
                Open System Settings
              </Button>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

export function MacPermissionsSettingsPanel() {
  const environmentId = useMacEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <SettingsSection title="Mac permissions">
          <SettingsRow
            {...searchableSetting("mac-permissions")}
            title="Not available"
            description="Mac permissions apply when T3 Code runs on a Mac, and a Mac environment is connected."
          />
        </SettingsSection>
      ) : (
        <MacPermissionsSections environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}
