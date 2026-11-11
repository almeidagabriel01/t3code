import { useAtomValue } from "@effect/atom-react";
import { linkedDeviceSources } from "@t3tools/client-runtime/state/device";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { DeviceServiceState, EnvironmentId } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { deviceEnvironment } from "~/state/device";
import { useLinkedEnvironments } from "~/state/peerLinks";
import { formatEnvironmentQueryError } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { DeviceLinkRequests } from "../device/DeviceLinkRequests";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Devices across linked environments: requests and uses from theirs here, with a way to shut
 * one out, and which linked environments' devices this one lists.
 */
export function DeviceLinksSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly state: DeviceServiceState;
  readonly hiddenSources: ReadonlyArray<string>;
}) {
  const { environmentId, state } = props;
  const canBlock = useAtomValue(deviceEnvironment.setLinkBlocked.permissionAtom(environmentId));
  const setBlocked = useAtomCommand(deviceEnvironment.setLinkBlocked, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const links = useLinkedEnvironments(environmentId);
  const sources = linkedDeviceSources({ links, hidden: props.hiddenSources, state });
  const clients = state.linkClients ?? [];
  const canHide = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));

  const report =
    (title: string) =>
    <A, E>(result: AtomCommandResult<A, E>) => {
      if (result._tag === "Failure")
        toastManager.add({
          type: "error",
          title,
          description: formatEnvironmentQueryError(result.cause),
        });
    };

  return (
    <>
      {(state.linkRequests ?? []).length > 0 ? (
        <SettingsSection id="device-link-requests" title="Device requests">
          <DeviceLinkRequests environmentId={environmentId} state={state} />
        </SettingsSection>
      ) : null}
      {clients.length > 0 ? (
        <SettingsSection id="device-link-clients" title="Linked environments using devices here">
          {clients.map((client) => (
            <SettingsRow
              key={client.linkId}
              title={client.label}
              description={
                client.blocked
                  ? "Shut out: it cannot list, watch or drive any device here."
                  : "Can use devices here under the access settings above."
              }
              control={
                <Button
                  size="sm"
                  variant={client.blocked ? "outline" : "destructive-outline"}
                  disabled={!canBlock}
                  onClick={() =>
                    void setBlocked({
                      environmentId,
                      input: {
                        linkId: client.linkId,
                        label: client.label,
                        blocked: !client.blocked,
                      },
                    }).then(report(`Could not change ${client.label}'s access`))
                  }
                >
                  {client.blocked ? "Let back in" : "Block"}
                </Button>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
      {sources.length > 0 ? (
        <SettingsSection id="device-linked-sources" title="Devices from linked environments">
          {sources.map((source) => (
            <SettingsRow
              key={source.environmentId}
              title={source.label}
              description={
                source.hidden
                  ? "Hidden: its devices are not listed here or offered to agents."
                  : (source.status ?? "Listed when it next answers.")
              }
              control={
                <Switch
                  checked={!source.hidden}
                  disabled={!canHide}
                  aria-label={`List devices from ${source.label}`}
                  onCheckedChange={(checked) =>
                    void update({
                      environmentId,
                      input: {
                        patch: {
                          hiddenLinkedDeviceSources: checked
                            ? props.hiddenSources.filter((id) => id !== source.environmentId)
                            : [...props.hiddenSources, source.environmentId],
                        },
                      },
                    }).then(report(`Could not change ${source.label}'s devices`))
                  }
                />
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}
