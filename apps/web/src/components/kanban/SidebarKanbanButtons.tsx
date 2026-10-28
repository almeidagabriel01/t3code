import { useNavigate } from "@tanstack/react-router";
import { SquareKanbanIcon } from "lucide-react";
import type { MouseEvent } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useKanbanEnvironmentIds } from "../../state/kanban";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isSidebarUtilityPage } from "../sidebar/mainAppLocation";
import { useLocation } from "@tanstack/react-router";

export function SidebarKanbanShortcut() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const supported = useKanbanEnvironmentIds().length > 0;
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  if (!supported || isOnUtilityPage) return null;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => {
            if (isMobile) setOpenMobile(false);
            void navigate({ to: "/kanban" });
          }}
        >
          <SquareKanbanIcon />
          <span>Board</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function SidebarProjectBoardButton({
  project,
}: {
  readonly project: SidebarProjectSnapshot;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const kanbanEnvironmentIds = useKanbanEnvironmentIds();
  if (
    !project.memberProjects.some((member) => kanbanEnvironmentIds.includes(member.environmentId))
  ) {
    return null;
  }
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/kanban", search: { projectKey: project.projectKey } });
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="micro"
            aria-label={`Open board of ${project.displayName}`}
            data-testid="project-board-button"
            onClick={onClick}
            onPointerDown={(event) => event.stopPropagation()}
          />
        }
      >
        <SquareKanbanIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">Board</TooltipPopup>
    </Tooltip>
  );
}
