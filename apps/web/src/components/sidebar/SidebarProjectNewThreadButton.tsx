import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { SquarePenIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { shortcutLabelForCommand } from "../../keybindings";
import { readLocalApi } from "../../localApi";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function memberLabel(member: SidebarProjectGroupMember, groupedProjectCount: number): string {
  if (groupedProjectCount <= 1) return member.title;
  return member.environmentLabel
    ? `${member.environmentLabel}: ${member.workspaceRoot}`
    : member.workspaceRoot;
}

function failureToast(title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export function SidebarProjectNewThreadButton({
  project,
}: {
  readonly project: SidebarProjectSnapshot;
}) {
  const handleNewThread = useNewThreadHandler();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut =
    shortcutLabelForCommand(keybindings, "chat.newLocal") ??
    shortcutLabelForCommand(keybindings, "chat.new");

  const createIn = async (member: SidebarProjectGroupMember) => {
    if (isMobile) setOpenMobile(false);
    const result = await settlePromise(() =>
      handleNewThread(scopeProjectRef(member.environmentId, member.id)),
    );
    if (result._tag === "Failure") failureToast("Could not create thread", result);
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const [only] = project.memberProjects;
    if (project.memberProjects.length === 1 && only !== undefined) {
      void createIn(only);
      return;
    }
    const api = readLocalApi();
    if (!api) return;
    void (async () => {
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          project.memberProjects.map((member) => ({
            id: member.physicalProjectKey,
            label: memberLabel(member, project.groupedProjectCount),
          })),
          { x: event.clientX, y: event.clientY },
        ),
      );
      if (clicked._tag === "Failure") {
        failureToast("Could not choose environment", clicked);
        return;
      }
      const target = project.memberProjects.find(
        (member) => member.physicalProjectKey === clicked.value,
      );
      if (target) await createIn(target);
    })();
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="micro"
            aria-label={`Create new thread in ${project.displayName}`}
            data-testid="new-thread-button"
            onClick={onClick}
            onPointerDown={(event) => event.stopPropagation()}
          />
        }
      >
        <SquarePenIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{shortcut ? `New thread (${shortcut})` : "New thread"}</TooltipPopup>
    </Tooltip>
  );
}
