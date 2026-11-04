import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { KeyboardEvent, MouseEvent } from "react";

import { useProjectPin } from "../../hooks/useProjectGroupUpdate";
import { readLocalApi } from "../../localApi";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { showProjectRowMenu } from "./projectRowMenu";

/** Pointer, button and keyboard entry points to one project row menu. */
export function useProjectRowMenu(input: {
  readonly openSettings: (group: SidebarProjectSnapshot) => void;
}) {
  const { canPinProjectGroup, toggleProjectGroupArchive } = useProjectPin();
  const open = (group: SidebarProjectSnapshot, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return Promise.resolve();
    return settlePromise(() =>
      showProjectRowMenu({
        show: (items, at) => api.contextMenu.show(items, at),
        archived: group.archived,
        canArchive: canPinProjectGroup(group),
        position,
        onSettings: () => input.openSettings(group),
        onToggleArchive: () => void toggleProjectGroupArchive(group),
      }),
    ).then(() => undefined);
  };
  const claim = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return {
    onContextMenu: (event: MouseEvent<HTMLElement>, group: SidebarProjectSnapshot) => {
      claim(event);
      return open(group, { x: event.clientX, y: event.clientY });
    },
    onButtonClick: (event: MouseEvent<HTMLElement>, group: SidebarProjectSnapshot) => {
      claim(event);
      const rect = event.currentTarget.getBoundingClientRect();
      return open(group, { x: rect.left, y: rect.bottom });
    },
    /** The menu key and Shift+F10 open it below the search field. */
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>, group: SidebarProjectSnapshot) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      claim(event);
      const rect = event.currentTarget.getBoundingClientRect();
      return open(group, { x: rect.left, y: rect.bottom });
    },
  };
}
