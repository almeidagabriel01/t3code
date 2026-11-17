import {
  ownProjectsWith,
  projectAccess,
  projectAccessBlocks,
  type ProjectAccessBlockTitle,
  type ProjectAccessKind,
} from "@t3tools/client-runtime/assistantProjectAccess";
import type { Assistant, AssistantTeamId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import {
  useAssistantActions,
  useAssistantEntries,
  useAssistantTeamActions,
  type AssistantReply,
} from "../../state/assistants";
import { cn } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { toastManager } from "../ui/toast";
import { StartTruncatedPath } from "../StartTruncatedPath";
import { AssistantAvatar } from "./assistantPresentation";
import { SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { settingsScopeEnvironmentAddress } from "../settings/settingsScopeAxis";
import { useEnvironments } from "../../state/environments";

function AccessRow(props: {
  readonly label: string;
  readonly leading?: ReactNode;
  readonly detail: string | null;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <li>
      <label
        className={cn(
          "flex items-center gap-2 rounded-md px-1.5 py-1 text-sm has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring/70",
          props.disabled ? "cursor-default" : "cursor-pointer hover:bg-foreground/8",
        )}
      >
        <Checkbox
          aria-label={props.label}
          checked={props.checked}
          disabled={props.disabled}
          onCheckedChange={(checked) => props.onChange(Boolean(checked))}
        />
        {props.leading}
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.detail === null ? null : (
          <span className="max-w-[50%] shrink-0 truncate text-xs text-muted-foreground">
            {props.detail}
          </span>
        )}
      </label>
    </li>
  );
}

const kindReason = (
  kind: ProjectAccessKind,
  viaTeams: ReadonlyArray<string>,
  isHome: boolean,
): string | null =>
  kind === "everywhere"
    ? "All projects"
    : kind === "group"
      ? `Via ${viaTeams.join(", ")}`
      : isHome && kind === "own"
        ? "Home project"
        : null;

export const PROJECT_ASSISTANT_ACCESS_INTRO =
  "A group gives every member access. An assistant can also have the project on its own list.";

/** Who can work in `projectIds`, checkouts of one environment that grant the same access. */
export function ProjectAssistantAccess(props: {
  readonly environmentId: EnvironmentId;
  readonly projectIds: ReadonlyArray<ProjectId>;
}) {
  const { environmentId, projectIds } = props;
  const { active, teams } = useAssistantEntries();
  const teamActions = useAssistantTeamActions(environmentId);
  const assistantActions = useAssistantActions(environmentId);
  const [busy, setBusy] = useState(false);
  const [individualOpen, setIndividualOpen] = useState(false);
  const access = projectAccess(
    projectIds[0]!,
    active.filter((entry) => entry.environmentId === environmentId).map((entry) => entry.assistant),
    teams.filter((entry) => entry.environmentId === environmentId).map((entry) => entry.team),
  );

  const change = async (reply: Promise<AssistantReply<unknown>>) => {
    setBusy(true);
    const result = await reply;
    setBusy(false);
    if (!result.ok) {
      toastManager.add({
        type: "error",
        title: "Could not change access",
        description: result.message,
      });
    }
  };
  const toggleGroup = (teamId: AssistantTeamId, on: boolean) =>
    change(
      teamActions.update(
        on ? { teamId, addProjectIds: projectIds } : { teamId, removeProjectIds: projectIds },
      ),
    );
  const toggleAssistant = (assistant: Assistant, on: boolean) => {
    const next = ownProjectsWith(assistant, projectIds, on);
    if (next === null) return;
    return change(assistantActions.update({ assistantId: assistant.id, projectIds: next }));
  };

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="text-sm font-medium">Groups</legend>
        {access.groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">No groups yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {access.groups.map(({ team, granted, members }) => (
              <AccessRow
                key={team.id}
                label={team.name}
                detail={`${members} ${members === 1 ? "member" : "members"}`}
                checked={granted}
                disabled={busy || !teamActions.canAct}
                onChange={(on) => void toggleGroup(team.id, on)}
              />
            ))}
          </ul>
        )}
      </fieldset>
      <Collapsible open={individualOpen} onOpenChange={setIndividualOpen}>
        <CollapsibleSectionHeader
          expanded={individualOpen}
          tone="emphasized"
          onClick={() => setIndividualOpen((open) => !open)}
        >
          Individual assistants
        </CollapsibleSectionHeader>
        <CollapsiblePanel>
          {access.assistants.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">No assistants yet.</p>
          ) : (
            <ul className="flex flex-col gap-0.5 pt-1">
              {access.assistants.map(({ assistant, kind, viaTeams, isHome }) => {
                const reason = kindReason(kind, viaTeams, isHome);
                return (
                  <AccessRow
                    key={assistant.id}
                    label={assistant.name}
                    leading={
                      <AssistantAvatar
                        assistant={assistant}
                        environmentId={environmentId}
                        className="size-5"
                      />
                    }
                    detail={reason}
                    checked={kind !== "none"}
                    disabled={busy || !assistantActions.canAct || reason !== null}
                    onChange={(on) => void toggleAssistant(assistant, on)}
                  />
                );
              })}
            </ul>
          )}
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function AccessBlockTitle(props: {
  readonly title: ProjectAccessBlockTitle;
  readonly address: string;
  readonly checkouts: ReadonlyArray<{
    readonly environmentLabel: string | null;
    readonly workspaceRoot: string;
  }>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {props.title.environment ? (
        <h3 className="text-sm font-medium">
          {props.checkouts[0]?.environmentLabel ?? "Environment"}
        </h3>
      ) : null}
      {props.title.address ? (
        <span className="truncate text-xs text-muted-foreground">{props.address}</span>
      ) : null}
      {props.title.path
        ? props.checkouts.map((checkout) => (
            <StartTruncatedPath
              key={checkout.workspaceRoot}
              path={checkout.workspaceRoot}
              className={cn(
                "block max-w-full",
                props.title.environment ? "text-xs text-muted-foreground" : "text-sm font-medium",
              )}
            />
          ))
        : null}
    </div>
  );
}

/**
 * The project's Settings section: one block per set of checkouts that grant the same access,
 * named only when there are several. Hidden where no environment has assistants.
 */
export function ProjectAssistantAccessSettings(props: {
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly environmentLabel: string | null;
    readonly workspaceRoot: string;
  }>;
}) {
  const { active, teams } = useAssistantEntries();
  const { environments } = useEnvironments();
  const blocks = projectAccessBlocks(props.members, active, teams);
  if (blocks.length === 0) return null;
  const addressOf = (environmentId: EnvironmentId) => {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    return environment ? settingsScopeEnvironmentAddress(environment) : environmentId;
  };
  return (
    <SettingsSection
      {...searchableSetting("assistants-with-access")}
      description={PROJECT_ASSISTANT_ACCESS_INTRO}
    >
      {blocks.map((block) => (
        <div
          key={`${block.environmentId}:${block.projectIds.join(",")}`}
          className="flex flex-col gap-3 px-3 py-3 sm:px-4"
        >
          {block.title === null ? null : (
            <AccessBlockTitle
              title={block.title}
              address={addressOf(block.environmentId)}
              checkouts={block.checkouts}
            />
          )}
          <ProjectAssistantAccess
            environmentId={block.environmentId}
            projectIds={block.projectIds}
          />
        </div>
      ))}
    </SettingsSection>
  );
}
