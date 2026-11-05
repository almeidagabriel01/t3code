import type { EnvironmentId } from "@t3tools/contracts";
import { Fragment } from "react";
import { teamSubtitle } from "@t3tools/client-runtime/assistantTeam";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  UserRoundIcon,
  EllipsisIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";

import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import {
  useAssistantEntries,
  useAssistantSpend,
  type AssistantEntry,
} from "../../state/assistants";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { AssistantAvatar, toolAccessLabel } from "../assistants/assistantPresentation";
import { openAssistantDialog } from "../assistants/assistantDialogState";
import { useAssistantFlows } from "../assistants/useAssistantFlows";
import { getDisplayModelName } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AutonomySection } from "./AutonomySettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function IconAction(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={props.label}
            disabled={props.disabled ?? false}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function AssistantRow(props: {
  readonly entry: AssistantEntry;
  readonly first: boolean;
  readonly team: string | null;
}) {
  const { assistant, environmentId } = props.entry;
  const archived = assistant.archivedAt !== null;
  const flows = useAssistantFlows(environmentId);
  const groups = useSidebarProjectGroups();
  const project = useProjects().find(
    (candidate) =>
      candidate.environmentId === environmentId && candidate.id === assistant.projectId,
  );
  const projectName = project?.isScratch
    ? "No project"
    : (groups.find((group) =>
        group.memberProjects.some(
          (member) => member.environmentId === environmentId && member.id === assistant.projectId,
        ),
      )?.displayName ??
      project?.title ??
      "Unknown project");
  const limitState = useAssistantSpend(
    environmentId,
    assistant.budget === null ? null : assistant.id,
  )?.budget?.state;
  const providers = useEnvironmentProviders().get(environmentId);
  const selection = useThreadShell(
    assistant.threadId ? scopeThreadRef(environmentId, assistant.threadId) : null,
  )?.modelSelection;
  const model = selection
    ? (() => {
        const found = providers
          ?.find((provider) => provider.instanceId === selection.instanceId)
          ?.models.find((candidate) => candidate.slug === selection.model);
        return found ? getDisplayModelName(found) : selection.model;
      })()
    : null;
  return (
    <SettingsRow
      {...(props.first && !archived ? searchableSetting("assistants") : {})}
      title={
        <span className="inline-flex items-center gap-2">
          <AssistantAvatar assistant={assistant} />
          {assistant.name}
        </span>
      }
      description={[
        `@${assistant.handle}`,
        props.team,
        projectName,
        toolAccessLabel(assistant.toolAccess),
        model,
        limitState === "exceeded" ? "Limit reached" : limitState === "warn" ? "Near limit" : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ")}
      control={
        <span className="flex items-center gap-1">
          {archived ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!flows.canAct}
              onClick={() => void flows.unarchive(assistant)}
            >
              <ArchiveRestoreIcon />
              Unarchive
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={assistant.threadId === null}
                onClick={() => flows.openConversation(assistant)}
              >
                <MessageSquareIcon />
                Open
              </Button>
              <IconAction
                label={`Edit ${assistant.name}`}
                onClick={() => openAssistantDialog({ environmentId, assistantId: assistant.id })}
              >
                <PencilIcon />
              </IconAction>
            </>
          )}
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`${assistant.name} actions`}
                      />
                    }
                  />
                }
              >
                <EllipsisIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">{assistant.name} actions</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end">
              {archived ? null : (
                <MenuItem disabled={!flows.canAct} onClick={() => void flows.reset(assistant)}>
                  <RefreshCwIcon />
                  Reset conversation
                </MenuItem>
              )}
              {archived ? null : <MenuSeparator />}
              {archived ? null : (
                <MenuItem disabled={!flows.canAct} onClick={() => void flows.archive(assistant)}>
                  <ArchiveIcon />
                  Archive assistant
                </MenuItem>
              )}
              <MenuItem
                variant="destructive"
                disabled={!flows.canAct}
                onClick={() => void flows.remove(assistant)}
              >
                <Trash2Icon />
                Delete assistant
              </MenuItem>
            </MenuPopup>
          </Menu>
        </span>
      }
    />
  );
}

function entryKey(entry: AssistantEntry): string {
  return `${entry.environmentId}:${entry.assistant.id}`;
}

function RestoreJarvisRow(props: { readonly environmentId: EnvironmentId }) {
  const flows = useAssistantFlows(props.environmentId);
  return (
    <SettingsRow
      title={
        <span className="inline-flex items-center gap-2">
          <UserRoundIcon className="size-4 text-muted-foreground" />
          Jarvis
        </span>
      }
      description="The default assistant was deleted. Restore him to chat with Jarvis again."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!flows.canAct}
          onClick={() => void flows.restoreDefault()}
        >
          <ArchiveRestoreIcon />
          Restore Jarvis
        </Button>
      }
    />
  );
}

export function AssistantsSettingsPanel() {
  const { active, archived, environmentIds } = useAssistantEntries();
  const { environments } = useEnvironments();
  const multipleEnvironments = environmentIds.length > 1;
  const labelOf = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;
  const inEnvironment = (entries: ReadonlyArray<AssistantEntry>, environmentId: EnvironmentId) =>
    entries.filter((entry) => entry.environmentId === environmentId);
  const teamOf = (entry: AssistantEntry) =>
    teamSubtitle(
      entry.assistant,
      [...active, ...archived]
        .filter((other) => other.environmentId === entry.environmentId)
        .map((other) => other.assistant),
    );

  return (
    <SettingsPageContainer>
      {environmentIds.length === 0 ? (
        <SettingsSection
          id={searchableSetting("assistants").id}
          title={searchableSetting("assistants").title}
          icon={<UserRoundIcon className="size-4 text-muted-foreground" />}
        >
          <SettingsRow
            title="No assistants available"
            description="Connect to a server that supports assistants, then they appear here."
          />
        </SettingsSection>
      ) : (
        environmentIds.map((environmentId, index) => {
          const entries = inEnvironment(active, environmentId);
          const hasDefault = [...entries, ...inEnvironment(archived, environmentId)].some(
            (entry) => entry.assistant.isDefault,
          );
          return (
            <Fragment key={environmentId}>
              <SettingsSection
                title={
                  multipleEnvironments ? `Assistants · ${labelOf(environmentId)}` : "Assistants"
                }
                icon={<UserRoundIcon className="size-4 text-muted-foreground" />}
                headerAction={
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => openAssistantDialog({ environmentId })}
                  >
                    <PlusIcon />
                    New assistant
                  </Button>
                }
              >
                {entries.map((entry, rowIndex) => (
                  <AssistantRow
                    key={entryKey(entry)}
                    entry={entry}
                    first={index === 0 && rowIndex === 0}
                    team={teamOf(entry)}
                  />
                ))}
                {hasDefault ? null : <RestoreJarvisRow environmentId={environmentId} />}
              </SettingsSection>
              <AutonomySection
                environmentId={environmentId}
                suffix={multipleEnvironments ? ` · ${labelOf(environmentId)}` : ""}
              />
            </Fragment>
          );
        })
      )}
      {environmentIds.map((environmentId) => {
        const entries = inEnvironment(archived, environmentId);
        return entries.length === 0 ? null : (
          <SettingsSection
            key={environmentId}
            title={multipleEnvironments ? `Archived · ${labelOf(environmentId)}` : "Archived"}
            icon={<ArchiveIcon className="size-4 text-muted-foreground" />}
          >
            {entries.map((entry) => (
              <AssistantRow
                key={entryKey(entry)}
                entry={entry}
                first={false}
                team={teamOf(entry)}
              />
            ))}
          </SettingsSection>
        );
      })}
    </SettingsPageContainer>
  );
}
