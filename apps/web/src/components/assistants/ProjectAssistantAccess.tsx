import {
  ownProjectsWith,
  projectAccess,
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
import { AssistantAvatar } from "./assistantPresentation";
import { SettingsSection } from "../settings/settingsLayout";

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

export function ProjectAssistantAccess(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, projectId } = props;
  const { active, teams } = useAssistantEntries();
  const teamActions = useAssistantTeamActions(environmentId);
  const assistantActions = useAssistantActions(environmentId);
  const [busy, setBusy] = useState(false);
  const [individualOpen, setIndividualOpen] = useState(false);
  const access = projectAccess(
    projectId,
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
        on ? { teamId, addProjectIds: [projectId] } : { teamId, removeProjectIds: [projectId] },
      ),
    );
  const toggleAssistant = (assistant: Assistant, on: boolean) => {
    const projectIds = ownProjectsWith(assistant, projectId, on);
    if (projectIds === null) return;
    return change(assistantActions.update({ assistantId: assistant.id, projectIds }));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        A group gives every member access. An assistant can also have the project on its own list.
      </p>
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

/** The project's Settings section; hidden where no environment has assistants. */
export function ProjectAssistantAccessSettings(props: {
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
}) {
  const { active, teams } = useAssistantEntries();
  const members = props.members.filter(
    (member) =>
      teams.some((entry) => entry.environmentId === member.environmentId) ||
      active.some((entry) => entry.environmentId === member.environmentId),
  );
  if (members.length === 0) return null;
  return (
    <SettingsSection title="Assistants with access">
      {members.map((member) => (
        <div key={`${member.environmentId}:${member.id}`} className="px-3 py-3 sm:px-4">
          <ProjectAssistantAccess environmentId={member.environmentId} projectId={member.id} />
        </div>
      ))}
    </SettingsSection>
  );
}
