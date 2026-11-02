import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ForkUpdateStatus } from "@t3tools/contracts";
import { useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { newProjectId } from "../../lib/utils";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { forkUpdateAction } from "../forkUpdates/forkUpdates.logic";
import {
  useForkUpdatesEnvironmentId,
  useForkUpdateStatus,
  useStartForkAgent,
} from "../forkUpdates/useForkUpdates";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function describeStatus(status: ForkUpdateStatus): string {
  const head = `${status.headSha?.slice(0, 8) ?? "unknown"}${status.headTag === null ? "" : ` (${status.headTag})`}`;
  const upstream = `${status.upstreamSha?.slice(0, 8) ?? "unknown"}${status.upstreamTag === null ? "" : ` (${status.upstreamTag})`}`;
  const behind =
    status.behind === 0
      ? "Up to date with upstream."
      : `${status.behind} commit${status.behind === 1 ? "" : "s"} behind upstream.`;
  return `Fork ${head}. Latest ${status.channel} ${upstream}. ${behind}`;
}

function conflictText(status: ForkUpdateStatus): string | null {
  if (status.behind === 0 || status.wouldConflict === null) return null;
  if (!status.wouldConflict) return "The merge applies cleanly.";
  const count = status.conflictFiles.length;
  return `Merging it would conflict in ${count} file${count === 1 ? "" : "s"}.`;
}

function ForkUpdatesSections({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const folder = useClientSettings((settings) => settings.forkUpdatesFolder);
  const channel = useClientSettings((settings) => settings.forkUpdatesChannel);
  const [draft, setDraft] = useState(folder);
  const { status, checking, check } = useForkUpdateStatus(environmentId);
  const startAgent = useStartForkAgent(environmentId, status);
  const createProject = useAtomCommand(projectEnvironment.create);
  const [adding, setAdding] = useState(false);
  const conflict = status === null ? null : conflictText(status);
  const action = status === null ? "none" : forkUpdateAction(status, startAgent !== null);
  const addProject = async (workspaceRoot: string) => {
    setAdding(true);
    await createProject({
      environmentId,
      input: {
        projectId: newProjectId(),
        title: inferProjectTitleFromPath(workspaceRoot),
        workspaceRoot,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: null,
      },
    });
    setAdding(false);
  };

  return (
    <SettingsSection id="fork-updates" title="Fork updates">
      <SettingsRow
        {...searchableSetting("fork-updates-folder")}
        description="Your fork's git checkout on this machine. Leave empty for ~/DEV/Pessoal/t3code."
        control={
          <Input
            className="w-72"
            value={draft}
            placeholder="~/DEV/Pessoal/t3code"
            aria-label="Fork checkout folder"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (draft !== folder) void updateClientSettings({ forkUpdatesFolder: draft.trim() });
            }}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("fork-updates-channel")}
        description="Stable and nightly are different apps. Auto follows the version your fork is built from."
        control={
          <Select
            value={channel}
            onValueChange={(next) => {
              if (next === "auto" || next === "stable" || next === "nightly") {
                void updateClientSettings({ forkUpdatesChannel: next });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-32 shrink-0" aria-label="Update channel">
              <SelectValue>
                {channel === "auto" ? "Auto" : channel === "stable" ? "Stable" : "Nightly"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="auto">
                Auto
              </SelectItem>
              <SelectItem hideIndicator value="stable">
                Stable
              </SelectItem>
              <SelectItem hideIndicator value="nightly">
                Nightly
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("fork-updates-status")}
        description={
          status === null
            ? "Checking upstream..."
            : status.available
              ? `${describeStatus(status)}${conflict === null ? "" : ` ${conflict}`}${
                  action === "add-project"
                    ? " Add the fork folder as a project so an agent can run the update."
                    : ""
                }`
              : `No fork checkout with an upstream remote at ${status.path}.`
        }
        control={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="compact" disabled={checking} onClick={check}>
              {checking ? "Checking..." : "Check now"}
            </Button>
            {status?.available && action === "add-project" ? (
              <Button size="compact" disabled={adding} onClick={() => void addProject(status.path)}>
                {adding ? "Adding..." : "Add project"}
              </Button>
            ) : null}
            {action === "update" || action === "resolve" ? (
              <Button size="compact" disabled={checking} onClick={() => void startAgent?.(action)}>
                {action === "update" ? "Update now" : "Resolve with agent"}
              </Button>
            ) : null}
          </div>
        }
      >
        {status?.available && status.wouldConflict && status.conflictFiles.length > 0 ? (
          <details className="group mt-2 text-xs">
            <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              Show conflicting files
            </summary>
            <ul className="mt-1.5 max-h-48 overflow-y-auto rounded-md border border-foreground/12 py-1 font-mono">
              {status.conflictFiles.map((file) => (
                <li
                  key={file}
                  className="truncate px-2 py-0.5 text-muted-foreground [direction:rtl] [text-align:left]"
                >
                  <bdi>{file}</bdi>
                </li>
              ))}
            </ul>
          </details>
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
