import type {
  IntegrationDirectoryRow,
  IntegrationMenuAction,
  IntegrationTone,
} from "@t3tools/client-runtime/integrations";
import {
  ChevronRightIcon,
  EllipsisIcon,
  KeyRoundIcon,
  KeySquareIcon,
  PlugIcon,
  Share2Icon,
  UnplugIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export const TONE_BADGE = {
  success: "success",
  warning: "warning",
  danger: "error",
  muted: "outline",
  progress: "info",
} as const satisfies Record<IntegrationTone, string>;

/** Catalog icons are one 24×24 path; anything else falls back to a plug. */
export function IntegrationIcon(props: { readonly icon: IntegrationDirectoryRow["icon"] }) {
  const { icon } = props;
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-foreground/12"
    >
      {icon !== null && !icon.svg.trimStart().startsWith("<") ? (
        <svg viewBox="0 0 24 24" className="size-4.5" fill={icon.color}>
          <path d={icon.svg} />
        </svg>
      ) : (
        <PlugIcon className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}

const MENU_ICONS = {
  "make-available": Share2Icon,
  disconnect: UnplugIcon,
  "use-token": KeyRoundIcon,
  "own-app": KeySquareIcon,
} as const;

export type IntegrationRowMenuAction =
  | IntegrationMenuAction
  | { readonly kind: "own-app"; readonly label: string };

const ROW_CLASS = "flex min-w-0 items-center gap-3 px-3 py-2.5 @md/integrations:px-4";

/**
 * One directory row. `onOpen` makes the row itself a button (detail sheet or custom servers);
 * without it the row is not clickable.
 */
export function IntegrationRow(props: {
  readonly row: IntegrationDirectoryRow;
  readonly onOpen: (() => void) | null;
  readonly action: ReactNode;
  readonly menu: ReadonlyArray<IntegrationRowMenuAction>;
  readonly onMenu: (action: IntegrationRowMenuAction) => void;
  readonly disabled: boolean;
}) {
  const { row } = props;
  const body = (
    <>
      <IntegrationIcon icon={row.icon} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{row.title}</span>
          {row.status ? (
            <Badge variant={TONE_BADGE[row.status.tone]} size="sm">
              {row.status.label}
            </Badge>
          ) : null}
          {row.origins.map((origin) => (
            <Badge key={origin.detectedId} variant="outline" size="sm">
              {origin.label}
            </Badge>
          ))}
        </span>
        {row.description === "" ? null : (
          <span className="truncate text-xs text-muted-foreground">{row.description}</span>
        )}
        {row.note === null ? null : (
          <span
            className={
              row.status?.tone === "warning" || row.status?.tone === "danger"
                ? "text-xs text-warning-foreground"
                : "text-xs text-muted-foreground"
            }
          >
            {row.note}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div data-testid="integration-row" className="flex min-w-0 items-center gap-1 pe-2">
      {props.onOpen === null ? (
        <div className={`${ROW_CLASS} flex-1`}>{body}</div>
      ) : (
        <button
          type="button"
          onClick={props.onOpen}
          className={`${ROW_CLASS} flex-1 cursor-pointer rounded-md text-start outline-hidden hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
        >
          {body}
          <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </button>
      )}
      {props.action}
      {props.menu.length === 0 ? null : (
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                disabled={props.disabled}
                aria-label={`More actions for ${row.title}`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            {props.menu.map((action) => {
              const Icon = MENU_ICONS[action.kind];
              return (
                <MenuItem
                  key={action.kind === "make-available" ? action.detectedId : action.kind}
                  onClick={() => props.onMenu(action)}
                >
                  <Icon />
                  {action.label}
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
}
