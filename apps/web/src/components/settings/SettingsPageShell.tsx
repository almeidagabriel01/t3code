import { XIcon } from "lucide-react";
import { useEffect, useEffectEvent, type ReactNode } from "react";

import { isElectron } from "../../env";
import { registerCommands } from "../../shortcuts/dispatcher";
import { useCloseAppModal } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";

const ESCAPE_OWNERS =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot$="popup"]';

/**
 * Settings as a page in the main area, on the same glass pane as threads. Esc or the close
 * button returns to the page that opened it.
 */
export function SettingsPageShell({
  pathname,
  actions,
  children,
}: {
  pathname: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const closeAppModal = useCloseAppModal();
  const closeSettings = useEffectEvent(() => {
    // Leaving unmounts a focused field without a blur, so commit-on-blur rows would
    // drop what was typed. Blur first so they commit.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
    void closeAppModal();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the Escape shortcut with the window-level dispatcher
  useEffect(
    () =>
      registerCommands(
        {},
        {
          observe: (event, consumed) => {
            if (consumed || event.defaultPrevented || event.repeat || event.isComposing) return;
            if (event.key !== "Escape") return;
            if (event.target instanceof Element && event.target.closest(ESCAPE_OWNERS)) return;
            event.preventDefault();
            closeSettings();
          },
        },
      ),
    [],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="relative" data-glass-layer>
        <div className="flex w-full min-w-0 items-center gap-3">
          <SettingsBreadcrumb pathname={pathname} />
          <div className="ms-auto flex shrink-0 items-center gap-1">
            {actions}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Close settings"
                    onClick={() => closeSettings()}
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
            </Tooltip>
          </div>
        </div>
      </WorkspacePageHeader>
      <div className="@container/settings relative flex min-h-0 flex-1 border-t">{children}</div>
    </SidebarInset>
  );
}
