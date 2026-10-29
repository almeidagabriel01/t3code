import { useNavigate } from "@tanstack/react-router";
import { LayoutGridIcon, NotebookPenIcon, SquareKanbanIcon } from "lucide-react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useKanbanEnvironmentIds } from "../../state/kanban";
import { useNotesEnvironmentIds } from "../../state/notes";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { useSidebar } from "../ui/sidebar";

/** One sidebar button for the project's board and notes, so the hover actions stay at two icons. */
export function SidebarProjectMenuButton({
  project,
}: {
  readonly project: SidebarProjectSnapshot;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const kanbanEnvironmentIds = useKanbanEnvironmentIds();
  const notesEnvironmentIds = useNotesEnvironmentIds();
  const hasBoard = project.memberProjects.some((member) =>
    kanbanEnvironmentIds.includes(member.environmentId),
  );
  const hasNotes = project.memberProjects.some((member) =>
    notesEnvironmentIds.includes(member.environmentId),
  );
  if (!hasBoard && !hasNotes) return null;
  const open = (to: "/kanban" | "/notes") => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to, search: { projectKey: project.projectKey } });
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost-muted"
            size="micro"
            aria-label={`Board and notes of ${project.displayName}`}
            data-testid="project-menu-button"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          />
        }
      >
        <LayoutGridIcon aria-hidden className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {hasBoard ? (
          <MenuItem data-testid="project-board-button" onClick={() => open("/kanban")}>
            <SquareKanbanIcon aria-hidden />
            Board
          </MenuItem>
        ) : null}
        {hasNotes ? (
          <MenuItem data-testid="project-notes-button" onClick={() => open("/notes")}>
            <NotebookPenIcon aria-hidden />
            Notes
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
