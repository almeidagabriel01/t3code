import { SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";

import { Kbd } from "~/components/ui/kbd";
import { Menu, MenuItem, MenuPopup } from "~/components/ui/menu";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings } from "~/hooks/useSettings";

import { fixedPanelKindOf } from "../../rightPanelFixedKinds";
import type { RightPanelSurface } from "../../rightPanelStore";
import {
  QUICK_BUTTON_META,
  RightPanelQuickButtonsCustomizer,
} from "./RightPanelQuickButtonsCustomizer";
import { visibleQuickButtons, type QuickButtonId } from "./rightPanelQuickButtons.logic";

interface FixedTabsProps {
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurfaceId: string | null;
  readonly onActivate: (surface: RightPanelSurface) => void;
  readonly onAdd: Record<QuickButtonId, () => void>;
  readonly available: Record<QuickButtonId, boolean>;
}

function surfaceMatches(surface: RightPanelSurface, id: QuickButtonId): boolean {
  return id === "pull-request"
    ? surface.kind === "pull-request"
    : surface.kind === id || fixedPanelKindOf(surface) === id;
}

/** Dynamic surfaces (files, pull requests, devices) stay in the tab strip below. */
export function RightPanelFixedTabs(props: FixedTabsProps) {
  const saved = useClientSettings((settings) => settings.rightPanelQuickButtons);
  const active = props.surfaces.find((surface) => surface.id === props.activeSurfaceId);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const anchor = menuPosition
    ? { getBoundingClientRect: () => new DOMRect(menuPosition.x, menuPosition.y, 0, 0) }
    : undefined;
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 border-b px-1.5 py-1"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
        setMenuOpen(true);
      }}
    >
      {visibleQuickButtons(saved, props.available).map((id) => {
        const { label, shortcut, icon: Icon } = QUICK_BUTTON_META[id];
        return (
          <Tooltip key={id}>
            <TooltipTrigger
              render={<span className="flex shrink-0 cursor-pointer has-disabled:cursor-default" />}
            >
              <Toggle
                aria-label={label}
                pressed={active !== undefined && surfaceMatches(active, id)}
                disabled={!props.available[id]}
                onPressedChange={() => {
                  const existing =
                    active && surfaceMatches(active, id)
                      ? active
                      : props.surfaces.find((surface) => surfaceMatches(surface, id));
                  if (existing) props.onActivate(existing);
                  else props.onAdd[id]();
                }}
                variant="ghost"
                size="sm"
              >
                <Icon className="size-4" />
              </Toggle>
            </TooltipTrigger>
            <TooltipPopup>
              <span className="flex items-center gap-2">
                {label}
                {shortcut ? <Kbd>{shortcut}</Kbd> : null}
              </span>
            </TooltipPopup>
          </Tooltip>
        );
      })}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              className="ms-auto shrink-0"
              size="icon-sm"
              variant="ghost"
              aria-label="Customize panel shortcuts"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenuPosition({ x: rect.left, y: rect.bottom });
                setCustomizing(true);
              }}
            />
          }
        >
          <SlidersHorizontalIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup>Customize shortcuts</TooltipPopup>
      </Tooltip>
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuPopup anchor={anchor} align="start" side="bottom">
          <MenuItem onClick={() => setCustomizing(true)}>Customize…</MenuItem>
        </MenuPopup>
      </Menu>
      <Popover
        open={customizing}
        onOpenChange={(open) => {
          if (open) return;
          setCustomizing(false);
        }}
      >
        <PopoverPopup
          anchor={anchor}
          side="bottom"
          align="start"
          padding="compact"
          width="md"
          aria-label="Panel shortcuts"
        >
          <RightPanelQuickButtonsCustomizer />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
