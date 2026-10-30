import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CheckIcon, FolderIcon, UnlinkIcon } from "lucide-react";

import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Shows the note's project and lets a person move the note to another, or to none. */
export function NoteProjectMenu(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  /** The server reports the project no longer exists. */
  missing?: boolean;
  disabled: boolean;
  onChange: (project: ProjectId | null) => void;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && project.isScratch !== true,
  );
  const current = projects.find((project) => project.id === props.projectId);
  if (props.projectId !== null && (props.missing === true || current === undefined))
    return (
      <div
        role="group"
        aria-label="Note project"
        className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-lg border border-border bg-card py-0.5 ps-2 pe-0.5 text-xs"
      >
        <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="py-0.5 text-muted-foreground">Project not found</span>
        {props.disabled ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Unlink project"
                  onClick={() => props.onChange(null)}
                />
              }
            >
              <UnlinkIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Remove the missing project from this note</TooltipPopup>
          </Tooltip>
        )}
      </div>
    );
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label="Note project"
            disabled={props.disabled}
          />
        }
      >
        <FolderIcon aria-hidden />
        {current?.title ?? "No project"}
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuItem onClick={() => props.onChange(null)}>
          No project
          {props.projectId === null ? <CheckIcon aria-hidden className="ms-auto" /> : null}
        </MenuItem>
        {projects.map((project) => (
          <MenuItem key={project.id} onClick={() => props.onChange(project.id)}>
            {project.title}
            {project.id === props.projectId ? <CheckIcon aria-hidden className="ms-auto" /> : null}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
