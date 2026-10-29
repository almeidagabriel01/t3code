import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CheckIcon, FolderIcon } from "lucide-react";

import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

/** Shows the note's project and lets a person move the note to another, or to none. */
export function NoteProjectMenu(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  disabled: boolean;
  onChange: (project: ProjectId | null) => void;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && project.isScratch !== true,
  );
  const current = projects.find((project) => project.id === props.projectId);
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
        {current?.title ?? (props.projectId ? "Unknown project" : "No project")}
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
