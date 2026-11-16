import {
  ownProjectsWith,
  projectAccess,
  projectAccessBlocks,
  type ProjectAccessBlockTitle,
} from "@t3tools/client-runtime/assistantProjectAccess";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListSection } from "../../components/ui/ListSection";
import {
  useAssistantActions,
  useAssistantEntries,
  useAssistantTeamActions,
  type AssistantReply,
} from "../../state/assistants";
import { ChoiceRow } from "./AssistantFormFields";
import { AssistantAvatar } from "./assistantPresentation";

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** Who can work in `projectIds`, checkouts of one environment that grant the same access. */
export function ProjectAssistantAccessSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly title?: {
    readonly environment: string | null;
    readonly paths: ReadonlyArray<string>;
  };
}) {
  const { environmentId, projectIds } = props;
  const entries = useAssistantEntries();
  const teamActions = useAssistantTeamActions(environmentId);
  const actions = useAssistantActions(environmentId);
  const [busy, setBusy] = useState(false);
  const teams = entries.teams
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.team);
  const assistants = entries.active
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.assistant);
  const access = projectAccess(projectIds[0]!, assistants, teams);
  if (access.groups.length === 0 && access.assistants.length === 0) return null;

  const run = async (change: () => Promise<AssistantReply<unknown>>, title: string) => {
    setBusy(true);
    const reply = await change();
    setBusy(false);
    if (!reply.ok) Dialog.alert(title, reply.message);
  };
  const canAct = teamActions.canAct && actions.canAct && !busy;

  return (
    <View className="gap-5">
      {props.title === undefined ? null : (
        <View className="gap-0.5 px-2">
          {props.title.environment === null ? null : (
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              {props.title.environment}
            </Text>
          )}
          {props.title.paths.map((path) => (
            <Text
              key={path}
              textRole="footnote"
              className={
                props.title?.environment === null
                  ? "font-t3-medium text-foreground"
                  : "text-foreground-muted"
              }
              numberOfLines={1}
              ellipsizeMode="head"
            >
              {path}
            </Text>
          ))}
        </View>
      )}
      {access.groups.length === 0 ? null : (
        <ListSection
          title="Groups"
          footer="Every member of a group can work in the projects the group has."
        >
          {access.groups.map(({ team, granted, members }) => (
            <ChoiceRow
              key={team.id}
              role="checkbox"
              icon="person.2"
              label={team.name}
              description={plural(members, "member")}
              selected={granted}
              disabled={!canAct}
              onPress={() =>
                void run(
                  () =>
                    teamActions.update({
                      teamId: team.id,
                      ...(granted
                        ? { removeProjectIds: projectIds }
                        : { addProjectIds: projectIds }),
                    }),
                  `Could not update ${team.name}`,
                )
              }
            />
          ))}
        </ListSection>
      )}
      {access.assistants.length === 0 ? null : (
        <ListSection title="Individual assistants">
          {access.assistants.map(({ assistant, kind, viaTeams, isHome }) => {
            const checked = kind !== "none";
            const next = ownProjectsWith(assistant, projectIds, !checked);
            const reason =
              kind === "everywhere"
                ? "All projects"
                : isHome
                  ? "Home project"
                  : kind === "group"
                    ? `Via ${viaTeams.join(", ")}`
                    : undefined;
            return (
              <ChoiceRow
                key={assistant.id}
                role="checkbox"
                leading={
                  <AssistantAvatar
                    assistant={assistant}
                    environmentId={props.environmentId}
                    size={24}
                  />
                }
                label={assistant.name}
                description={reason}
                selected={checked}
                disabled={!canAct || reason !== undefined || next === null}
                onPress={() =>
                  next === null
                    ? undefined
                    : void run(
                        () => actions.update({ assistantId: assistant.id, projectIds: next }),
                        `Could not update ${assistant.name}`,
                      )
                }
              />
            );
          })}
        </ListSection>
      )}
    </View>
  );
}

const blockTitle = (
  title: ProjectAccessBlockTitle | null,
  checkouts: ReadonlyArray<{ readonly workspaceRoot: string }>,
  environment: string,
) =>
  title === null
    ? undefined
    : {
        environment: title.environment ? environment : null,
        paths: title.path ? checkouts.map((checkout) => checkout.workspaceRoot) : [],
      };

/** One section per set of checkouts that grant the same access, named only when there are several. */
export function ProjectAssistantAccessSections(props: {
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | undefined;
}) {
  const { active, teams } = useAssistantEntries();
  return projectAccessBlocks(props.members, active, teams).map((block) => {
    const title = blockTitle(
      block.title,
      block.checkouts,
      props.environmentLabel(block.environmentId) ?? "Environment",
    );
    return (
      <ProjectAssistantAccessSection
        key={`${block.environmentId}:${block.projectIds.join(",")}`}
        environmentId={block.environmentId}
        projectIds={block.projectIds}
        {...(title === undefined ? {} : { title })}
      />
    );
  });
}
