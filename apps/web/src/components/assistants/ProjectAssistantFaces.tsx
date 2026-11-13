import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectAssistants } from "@t3tools/client-runtime/assistantSections";
import {
  assistantWorkingHereLabel,
  projectAssistantFaces,
} from "@t3tools/client-runtime/assistantLiveWork";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useAssistantEntries, useAssistantLiveWork } from "../../state/assistants";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AssistantAvatar } from "./assistantPresentation";

const MAX_FACES = 2;

/**
 * Faces of the assistants working in a project, then of its configured ones, for its header row, which is itself a button: each face is a
 * `role="button"` span and swallows the events that would fold the project or start a drag.
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
  const shown = faces.slice(0, MAX_FACES);
  const hidden = faces.length - shown.length;
  return (
    <span data-testid="project-assistant-faces" className="flex shrink-0 items-center">
      {shown.map(({ entry: { assistant, environmentId }, site }) => {
        const label =
          site === null ? `Open ${assistant.name}` : assistantWorkingHereLabel(assistant.name);
        const open = () => {
          if (site !== null) props.onOpen(scopeThreadRef(site.environmentId, site.threadId));
          else if (assistant.threadId !== null)
            props.onOpen(scopeThreadRef(environmentId, assistant.threadId));
        };
        return (
          <Tooltip key={`${environmentId}:${assistant.id}`}>
            <TooltipTrigger
              render={
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  data-testid="project-assistant-face"
                  data-working={site === null ? undefined : true}
                  className="-ms-1 flex size-5 first:ms-0 cursor-pointer items-center justify-center rounded-full outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    open();
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    open();
                  }}
                />
              }
            >
              <AssistantAvatar
                assistant={assistant}
                environmentId={environmentId}
                {...(site === null ? {} : { mood: site.face })}
                className="size-3.5"
              />
            </TooltipTrigger>
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
        );
      })}
      {hidden > 0 ? (
        <span className="ms-1 text-xs tabular-nums text-sidebar-muted-foreground">+{hidden}</span>
      ) : null}
    </span>
  );
}
