import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileDiff,
  Files,
  Globe2,
  MessagesSquareIcon,
  NotebookPenIcon,
  RotateCcwIcon,
  Smartphone,
  TerminalSquare,
} from "lucide-react";
import type { ComponentType } from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { persistClientSettingsUpdate, useClientSettings } from "~/hooks/useSettings";

import {
  customizerQuickButtons,
  DEFAULT_QUICK_BUTTONS,
  moveQuickButton,
  setQuickButtonShown,
  type QuickButtonId,
} from "./rightPanelQuickButtons.logic";

export const QUICK_BUTTON_META: Record<
  QuickButtonId,
  {
    label: string;
    shortcut: string | null;
    icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  }
> = {
  files: { label: "Files", shortcut: "F", icon: Files },
  diff: { label: "Diff", shortcut: "D", icon: FileDiff },
  terminal: { label: "Terminal", shortcut: "T", icon: TerminalSquare },
  preview: { label: "Browser", shortcut: "B", icon: Globe2 },
  "pull-requests": { label: "Linked pull requests", shortcut: "L", icon: PullRequestGlyph.link },
  "pull-request": { label: "Pull request", shortcut: "P", icon: PullRequestGlyph.pullRequest },
  notes: { label: "Notes", shortcut: "N", icon: NotebookPenIcon },
  "side-chat": { label: "Side chat", shortcut: null, icon: MessagesSquareIcon },
  device: { label: "Device", shortcut: "M", icon: Smartphone },
};

function updateQuickButtons(update: (saved: ReadonlyArray<string>) => string[]) {
  persistClientSettingsUpdate((current) => ({
    ...current,
    rightPanelQuickButtons: update(current.rightPanelQuickButtons),
  })).catch((error: unknown) => {
    console.error("Could not save the panel shortcuts.", error);
  });
}

export function isDefaultQuickButtons(saved: ReadonlyArray<string>): boolean {
  return saved.join() === DEFAULT_QUICK_BUTTONS.join();
}

export function resetQuickButtons() {
  updateQuickButtons(() => [...DEFAULT_QUICK_BUTTONS]);
}

/** Popover body that shows, hides, and reorders the panel's quick buttons. */
export function RightPanelQuickButtonsCustomizer() {
  const saved = useClientSettings((settings) => settings.rightPanelQuickButtons);
  const rows = customizerQuickButtons(saved);
  const shownCount = rows.filter((id) => saved.includes(id)).length;
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">Panel shortcuts</div>
      <ul className="flex flex-col">
        {rows.map((id, index) => {
          const { label, icon: Icon } = QUICK_BUTTON_META[id];
          const shown = index < shownCount;
          return (
            <li key={id} className="flex min-h-8 items-center gap-2 rounded-md px-1">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <Checkbox
                  checked={shown}
                  onCheckedChange={(next) =>
                    updateQuickButtons((current) => setQuickButtonShown(current, id, next))
                  }
                />
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{label}</span>
              </label>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Move ${label} up`}
                disabled={!shown || index === 0}
                onClick={() => updateQuickButtons((current) => moveQuickButton(current, id, -1))}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Move ${label} down`}
                disabled={!shown || index === shownCount - 1}
                onClick={() => updateQuickButtons((current) => moveQuickButton(current, id, 1))}
              >
                <ArrowDownIcon />
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="mt-1 border-t border-border pt-1">
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={isDefaultQuickButtons(saved)}
          onClick={resetQuickButtons}
        >
          <RotateCcwIcon />
          Reset to default
        </Button>
      </div>
    </div>
  );
}
