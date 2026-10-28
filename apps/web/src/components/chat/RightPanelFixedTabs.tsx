import { FileDiff, Files, Globe2, TerminalSquare } from "lucide-react";
import type { ComponentType } from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { fixedPanelKindOf, type FixedPanelKind } from "../../rightPanelFixedKinds";
import type { RightPanelSurface } from "../../rightPanelStore";

interface FixedTabsProps {
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurfaceId: string | null;
  readonly onActivate: (surface: RightPanelSurface) => void;
  readonly onAdd: Record<FixedPanelKind, () => void>;
  readonly available: Record<FixedPanelKind, boolean>;
}

const TABS: ReadonlyArray<{
  kind: FixedPanelKind;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { kind: "files", label: "Files", icon: Files },
  { kind: "diff", label: "Diff", icon: FileDiff },
  { kind: "terminal", label: "Terminal", icon: TerminalSquare },
  { kind: "preview", label: "Browser", icon: Globe2 },
  { kind: "pull-requests", label: "Pull requests", icon: PullRequestGlyph.link },
];

/** Dynamic surfaces (files, pull requests, devices) stay in the tab strip below. */
export function RightPanelFixedTabs(props: FixedTabsProps) {
  const active = props.surfaces.find((surface) => surface.id === props.activeSurfaceId);
  const activeKind = active ? fixedPanelKindOf(active) : null;
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b px-1.5 py-1">
      {TABS.map(({ kind, label, icon: Icon }) => (
        <Tooltip key={kind}>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              aria-label={label}
              pressed={activeKind === kind}
              disabled={!props.available[kind]}
              onPressedChange={() => {
                const existing =
                  active && fixedPanelKindOf(active) === kind
                    ? active
                    : props.surfaces.find((surface) => fixedPanelKindOf(surface) === kind);
                if (existing) props.onActivate(existing);
                else props.onAdd[kind]();
              }}
              variant="ghost"
              size="sm"
            >
              <Icon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup>{label}</TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
