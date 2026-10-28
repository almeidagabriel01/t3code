import type { EnvironmentId, ForkUpdateStatus } from "@t3tools/contracts";
import { useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import {
  useForkUpdatesEnvironmentId,
  useForkUpdateStatus,
  useStartForkAgent,
} from "../forkUpdates/useForkUpdates";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function describeStatus(status: ForkUpdateStatus): string {
  const head = `${status.headSha?.slice(0, 8) ?? "unknown"}${status.headTag === null ? "" : ` (${status.headTag})`}`;
  const upstream = `${status.upstreamSha?.slice(0, 8) ?? "unknown"}${status.upstreamTag === null ? "" : ` (${status.upstreamTag})`}`;
  const behind =
    status.behind === 0
      ? "Up to date with upstream."
      : `${status.behind} commit${status.behind === 1 ? "" : "s"} behind upstream.`;
  return `Fork ${head}. Upstream ${upstream}. ${behind}`;
}

function conflictText(status: ForkUpdateStatus): string | null {
  if (status.behind === 0 || status.wouldConflict === null) return null;
  if (!status.wouldConflict) return "The merge would apply cleanly.";
  return `The merge would conflict in ${status.conflictFiles.length} file${status.conflictFiles.length === 1 ? "" : "s"}: ${status.conflictFiles.slice(0, 5).join(", ")}${status.conflictFiles.length > 5 ? ", ..." : ""}`;
}

function ForkUpdatesSections({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const folder = useClientSettings((settings) => settings.forkUpdatesFolder);
  const [draft, setDraft] = useState(folder);
  const { status, checking, check } = useForkUpdateStatus(environmentId);
  const startAgent = useStartForkAgent(environmentId, status?.available ? status.path : null);
  const conflict = status === null ? null : conflictText(status);

  return (
    <SettingsSection id="fork-updates" title="Fork updates">
      <SettingsRow
        {...searchableSetting("fork-updates-folder")}
        description="Your fork's git checkout on this machine. Leave empty for ~/Documents/DEV/t3code."
        control={
          <Input
            className="w-72"
            value={draft}
            placeholder="~/Documents/DEV/t3code"
            aria-label="Fork checkout folder"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (draft !== folder) void updateClientSettings({ forkUpdatesFolder: draft.trim() });
            }}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("fork-updates-status")}
        description={
          status === null
            ? "Checking upstream..."
            : status.available
              ? `${describeStatus(status)}${conflict === null ? "" : ` ${conflict}`}`
              : `No fork checkout with an upstream remote at ${status.path}.`
        }
        control={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="compact" disabled={checking} onClick={check}>
              {checking ? "Checking..." : "Check now"}
            </Button>
            <Button
              size="compact"
              disabled={startAgent === null || checking}
              onClick={() => void startAgent?.("update")}
            >
              Update now
            </Button>
            <Button
              variant={status?.wouldConflict ? "default" : "outline"}
              size="compact"
              disabled={startAgent === null || checking}
              onClick={() => void startAgent?.("resolve")}
            >
              Resolve with agent
            </Button>
          </div>
        }
      >
        {status?.available && startAgent === null ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Add {status.path} as a project to start update threads from here.
          </p>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

export function ForkUpdatesSettingsPanel() {
  const environmentId = useForkUpdatesEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <SettingsSection id="fork-updates" title="Fork updates">
          <SettingsRow
            title="Not available"
            description="Fork updates need the local T3 Code server on this machine."
          />
        </SettingsSection>
      ) : (
        <ForkUpdatesSections environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}
