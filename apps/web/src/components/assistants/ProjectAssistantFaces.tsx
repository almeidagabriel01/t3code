import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectAssistants } from "@t3tools/client-runtime/assistantSections";
import {
  assistantWorkingHereLabel,
  projectAssistantFaces,
} from "@t3tools/client-runtime/assistantLiveWork";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SyntheticEvent } from "react";

import { useAssistantEntries, useAssistantLiveWork } from "../../state/assistants";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AssistantAvatar, AssistantCluster } from "./assistantPresentation";

const TRIGGER =
  "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The header row is a sortable button: nothing here may fold the project or start a drag. */
const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The assistants working in a project, then its configured ones, as one cluster in its header row.
 * One assistant opens on click; several open a menu to pick from (the menu's portal still bubbles
 * React events through this wrapper).
 */
export function ProjectAssistantFaces(props: {
  readonly members: ReadonlyArray<{ readonly environmentId: string; readonly id: string }>;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { active } = useAssistantEntries();
  const { sites } = useAssistantLiveWork();
  const members = props.members.map((member) => ({
    environmentId: member.environmentId,
    projectId: member.id,
  }));
  const faces = projectAssistantFaces({
    assistants: active,
    configured: projectAssistants(active, members),
    sites,
    members,
  });
  if (faces.length === 0) return null;
  const rows = faces.map(({ entry: { assistant, environmentId }, site }) => ({
    key: `${environmentId}:${assistant.id}`,
    assistant,
    environmentId,
    site,
    label: site === null ? `Open ${assistant.name}` : assistantWorkingHereLabel(assistant.name),
    open: () => {
      if (site !== null) props.onOpen(scopeThreadRef(site.environmentId, site.threadId));
      else if (assistant.threadId !== null)
        props.onOpen(scopeThreadRef(environmentId, assistant.threadId));
    },
  }));
  const cluster = (
    <AssistantCluster
      faces={rows.map((row) => ({
        key: row.key,
        assistant: row.assistant,
        ...(row.site === null ? {} : { mood: row.site.face }),
      }))}
      environmentId={rows[0]!.environmentId}
      className="size-4"
    />
  );
  const only = rows.length === 1 ? rows[0]! : null;
  return (
    <span
      data-testid="project-assistant-faces"
      className="flex shrink-0 items-center"
      onPointerDown={stop}
      onClick={stop}
      onKeyDown={stop}
    >
      {only !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="button"
                tabIndex={0}
                aria-label={only.label}
                data-testid="project-assistant-face"
                data-working={only.site === null ? undefined : true}
                className={TRIGGER}
                onClick={only.open}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  only.open();
                }}
              />
            }
          >
            {cluster}
          </TooltipTrigger>
          <TooltipPopup side="top">{only.label}</TooltipPopup>
        </Tooltip>
      ) : (
        <Menu>
          <MenuTrigger
            nativeButton={false}
            render={
              <span
                role="button"
                tabIndex={0}
                aria-label={`Assistants in this project: ${rows.length}`}
                className={TRIGGER}
              />
            }
          >
            {cluster}
          </MenuTrigger>
          <MenuPopup align="start">
            {rows.map((row) => (
              <MenuItem
                key={row.key}
                data-testid="project-assistant-face"
                data-working={row.site === null ? undefined : true}
                onClick={row.open}
              >
                <AssistantAvatar
                  assistant={row.assistant}
                  environmentId={row.environmentId}
                  {...(row.site === null ? {} : { mood: row.site.face })}
                  className="size-4"
                />
                {row.label}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      )}
    </span>
  );
}
