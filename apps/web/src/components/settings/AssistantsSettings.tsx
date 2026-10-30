import type { EnvironmentId } from "@t3tools/contracts";
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
import { useAssistantEntries, type AssistantEntry } from "../../state/assistants";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { AssistantAvatar, toolAccessLabel } from "../assistants/assistantPresentation";
import { openAssistantDialog } from "../assistants/assistantDialogState";
import { useAssistantFlows } from "../assistants/useAssistantFlows";
import { getDisplayModelName } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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

function AssistantRow(props: { readonly entry: AssistantEntry; readonly first: boolean }) {
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
        projectName,
        toolAccessLabel(assistant.toolAccess),
        model,
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
              {assistant.isDefault ? null : (
                <>
                  {archived ? null : <MenuSeparator />}
                  {archived ? null : (
                    <MenuItem
                      disabled={!flows.canAct}
                      onClick={() => void flows.archive(assistant)}
                    >
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
                </>
              )}
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

export function AssistantsSettingsPanel() {
  const { active, archived } = useAssistantEntries();
  const { environments } = useEnvironments();
  const multipleEnvironments =
    new Set([...active, ...archived].map((e) => e.environmentId)).size > 1;
  const labelOf = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;
  const byEnvironment = (entries: ReadonlyArray<AssistantEntry>) => {
    const groups = new Map<EnvironmentId, AssistantEntry[]>();
    for (const entry of entries) {
      groups.set(entry.environmentId, [...(groups.get(entry.environmentId) ?? []), entry]);
    }
    return [...groups];
  };
  const environmentIds = [...new Set([...active, ...archived].map((e) => e.environmentId))];

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
        byEnvironment(active).map(([environmentId, entries], index) => (
          <SettingsSection
            key={environmentId}
            title={multipleEnvironments ? `Assistants · ${labelOf(environmentId)}` : "Assistants"}
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
              />
            ))}
          </SettingsSection>
        ))
      )}
      {archived.length > 0
        ? byEnvironment(archived).map(([environmentId, entries]) => (
            <SettingsSection
              key={environmentId}
              title={multipleEnvironments ? `Archived · ${labelOf(environmentId)}` : "Archived"}
              icon={<ArchiveIcon className="size-4 text-muted-foreground" />}
            >
              {entries.map((entry) => (
                <AssistantRow key={entryKey(entry)} entry={entry} first={false} />
              ))}
            </SettingsSection>
          ))
        : null}
    </SettingsPageContainer>
  );
}
