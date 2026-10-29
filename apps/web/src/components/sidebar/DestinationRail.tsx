import { useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BellIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  HouseIcon,
  NotebookPenIcon,
  PlugIcon,
  PlusIcon,
  RotateCcwIcon,
  SettingsIcon,
  SquareKanbanIcon,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  Fragment,
  lazy,
  memo,
  Suspense,
  useContext,
  useState,
  type MouseEvent,
  type ReactElement,
} from "react";

import { PullRequestGlyph, type PullRequestGlyphIcon } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isElectron } from "../../env";
import {
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrationStatus,
} from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  useEnvironment,
  usePrimaryEnvironmentId,
  usePullRequestsSupported,
} from "../../state/environments";
import { useKanbanEnvironmentIds } from "../../state/kanban";
import { useNotesEnvironmentIds } from "../../state/notes";
import { useActivityBadge } from "../activity/useActivity";
import { providerReadyAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DEFAULT_RAIL_PREFERENCES,
  moveRailItem,
  railPreferencesForHydration,
  resolveActiveDestination,
  resolveRailItems,
  setRailItemShown,
  type DestinationId,
  type RailContext,
  type RailItemId,
  type RailPreferences,
  type ResolvedRailItem,
} from "./destinationRail.logic";
import { isAppModalPage, useCloseAppModal, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarForkUpdatePill } from "./SidebarForkUpdatePill";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

// The wizard only loads once someone opens it from the rail.
const AddProviderInstanceDialog = lazy(() =>
  import("../settings/AddProviderInstanceDialog").then((module) => ({
    default: module.AddProviderInstanceDialog,
  })),
);

/** True while the desktop destination rail is on screen; the sidebar footer drops its duplicates. */
export const DestinationRailVisibleContext = createContext(false);

export function useDestinationRailVisible(): boolean {
  return useContext(DestinationRailVisibleContext);
}

// The rail owns aria-current; Link's own fuzzy matching would also mark /settings on its
// subpages.
const EXACT_MATCH = { exact: true } as const;

const RAIL_ITEMS: Record<
  RailItemId,
  { label: string; icon: LucideIcon | PullRequestGlyphIcon; unavailable?: string }
> = {
  activity: { label: "Activity", icon: BellIcon },
  board: {
    label: "Board",
    icon: SquareKanbanIcon,
    unavailable: "No connected environment has a board",
  },
  notes: {
    label: "Notes",
    icon: NotebookPenIcon,
    unavailable: "No connected environment has notes",
  },
  pullRequests: {
    label: "Pull requests",
    icon: PullRequestGlyph.pullRequest,
    unavailable: "No connected environment supports pull requests",
  },
  usage: { label: "Usage", icon: ChartNoAxesColumnIcon },
  scheduled: { label: "Scheduled tasks", icon: CalendarClockIcon },
  archived: { label: "Archived", icon: ArchiveIcon },
  addProvider: {
    label: "Add provider",
    icon: PlugIcon,
    unavailable: "Needs a primary environment where you can manage providers",
  },
};

function railItemClassName(active: boolean) {
  return cn(
    "relative flex size-10 shrink-0 items-center justify-center rounded-lg outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-5",
    // The rail sits on the window background, where the sidebar's row fills (tuned for the
    // sidebar surface) barely show; the accent pair keeps both states visible in every theme.
    active
      ? "bg-accent text-accent-foreground"
      : "text-sidebar-muted-foreground hover:bg-accent hover:text-accent-foreground",
  );
}

function RailCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      className="absolute -top-1 -right-1 min-w-4 rounded-full bg-primary px-1 text-center text-3xs leading-4 font-medium text-primary-foreground tabular-nums"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function RailTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Clicking the current destination goes back to the thread it was opened over. */
function useToggleBack(active: DestinationId) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigateToMainApp = useNavigateToMainApp();
  const closeAppModal = useCloseAppModal();
  return (id: DestinationId) => (event: MouseEvent) => {
    if (active !== id || id === "home") return;
    event.preventDefault();
    void (isAppModalPage(pathname) ? closeAppModal() : navigateToMainApp());
  };
}

type ToggleBack = ReturnType<typeof useToggleBack>;

const ActivityRailItem = memo(function ActivityRailItem(props: {
  active: boolean;
  onClick: (event: MouseEvent) => void;
}) {
  const count = useActivityBadge();
  const label = count === 0 ? "Activity" : `Activity, ${count} need attention`;
  return (
    <RailTooltip label={label}>
      <Link
        to="/activity"
        aria-label={label}
        activeOptions={EXACT_MATCH}
        aria-current={props.active ? "page" : undefined}
        className={railItemClassName(props.active)}
        onClick={props.onClick}
      >
        <BellIcon aria-hidden />
        <RailCount count={count} />
      </Link>
    </RailTooltip>
  );
});

// Rail items, Home included, above the divider. It follows position, not particular items, so
// it stays put as people reorder or hide items.
const RAIL_DIVIDER_AFTER = 6;

const ADD_PROVIDER_BUTTON_ID = "destination-rail-add-provider";
const CUSTOMIZE_RAIL_BUTTON_ID = "destination-rail-customize";

const unknownProviderReadyAtom = Atom.make<boolean | null>(null);

interface AddProviderTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

function RailLink(props: {
  id: DestinationId;
  label: string;
  icon: ReactElement;
  active: DestinationId;
  toggleBack: ToggleBack;
  to:
    | "/kanban"
    | "/notes"
    | "/usage"
    | "/settings/scheduled-tasks"
    | "/settings/archived"
    | "/settings";
}) {
  const active = props.active === props.id;
  return (
    <RailTooltip label={props.label}>
      <Link
        to={props.to}
        aria-label={props.label}
        activeOptions={EXACT_MATCH}
        aria-current={active ? "page" : undefined}
        className={railItemClassName(active)}
        onClick={props.toggleBack(props.id)}
      >
        {props.icon}
      </Link>
    </RailTooltip>
  );
}

function RailItem(props: {
  id: RailItemId;
  active: DestinationId;
  toggleBack: ToggleBack;
  onAddProvider: () => void;
}) {
  const { active, toggleBack } = props;
  switch (props.id) {
    case "activity":
      return <ActivityRailItem active={active === "activity"} onClick={toggleBack("activity")} />;
    case "board":
      return (
        <RailLink
          id="board"
          to="/kanban"
          label="Board"
          icon={<SquareKanbanIcon aria-hidden />}
          active={active}
          toggleBack={toggleBack}
        />
      );
    case "notes":
      return (
        <RailLink
          id="notes"
          to="/notes"
          label="Notes"
          icon={<NotebookPenIcon aria-hidden />}
          active={active}
          toggleBack={toggleBack}
        />
      );
    case "pullRequests":
      return (
        <RailTooltip label="Pull requests">
          <Link
            to="/pull-requests"
            search={readPullRequestListPreferences()}
            aria-label="Pull requests"
            activeOptions={EXACT_MATCH}
            aria-current={active === "pullRequests" ? "page" : undefined}
            className={railItemClassName(active === "pullRequests")}
            onClick={toggleBack("pullRequests")}
          >
            <PullRequestGlyph.pullRequest aria-hidden />
          </Link>
        </RailTooltip>
      );
    case "usage":
      return (
        <RailLink
          id="usage"
          to="/usage"
          label="Usage"
          icon={<ChartNoAxesColumnIcon aria-hidden />}
          active={active}
          toggleBack={toggleBack}
        />
      );
    case "scheduled":
      return (
        <RailLink
          id="scheduled"
          to="/settings/scheduled-tasks"
          label="Scheduled tasks"
          icon={<CalendarClockIcon aria-hidden />}
          active={active}
          toggleBack={toggleBack}
        />
      );
    case "archived":
      return (
        <RailLink
          id="archived"
          to="/settings/archived"
          label="Archived"
          icon={<ArchiveIcon aria-hidden />}
          active={active}
          toggleBack={toggleBack}
        />
      );
    case "addProvider":
      return (
        <RailTooltip label="Add provider">
          <button
            id={ADD_PROVIDER_BUTTON_ID}
            type="button"
            aria-label="Add provider"
            aria-haspopup="dialog"
            className={railItemClassName(false)}
            onClick={props.onAddProvider}
          >
            <PlugIcon aria-hidden />
          </button>
        </RailTooltip>
      );
  }
}

function updateRailPreferences(update: (preferences: RailPreferences) => RailPreferences) {
  persistClientSettingsUpdate((current) => ({
    ...current,
    destinationRail: update(current.destinationRail),
  })).catch((error: unknown) => {
    console.error("Could not save the rail items.", error);
  });
}

/** The "+" menu: every rail item, whether it shows, and its place, including ones unavailable here. */
function RailCustomizeMenu(props: { items: ReadonlyArray<ResolvedRailItem> }) {
  const last = props.items.length - 1;
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  id={CUSTOMIZE_RAIL_BUTTON_ID}
                  type="button"
                  aria-label="Customize rail"
                  className={railItemClassName(false)}
                />
              }
            >
              <PlusIcon aria-hidden />
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="right">Customize rail</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="right" align="end" padding="compact" width="sm" aria-label="Rail items">
        <div className="flex flex-col gap-0.5 text-sm">
          <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">Show in rail</div>
          <ul className="flex flex-col">
            {props.items.map((item, index) => {
              const meta = RAIL_ITEMS[item.id];
              const Icon = meta.icon;
              const checked =
                item.choice === "default" ? item.defaultShown : item.choice === "shown";
              return (
                <li key={item.id} className="flex min-h-8 items-center gap-2 rounded-md px-1">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 has-disabled:cursor-default">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) =>
                        updateRailPreferences((preferences) =>
                          setRailItemShown(preferences, item.id, next),
                        )
                      }
                    />
                    <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{meta.label}</span>
                      {!item.available && meta.unavailable ? (
                        <span className="text-xs text-muted-foreground">{meta.unavailable}</span>
                      ) : null}
                    </span>
                  </label>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Move ${meta.label} up`}
                    disabled={index === 0}
                    onClick={() =>
                      updateRailPreferences((preferences) => moveRailItem(preferences, item.id, -1))
                    }
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Move ${meta.label} down`}
                    disabled={index === last}
                    onClick={() =>
                      updateRailPreferences((preferences) => moveRailItem(preferences, item.id, 1))
                    }
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
              onClick={() => updateRailPreferences(() => DEFAULT_RAIL_PREFERENCES)}
            >
              <RotateCcwIcon />
              Reset to defaults
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** The desktop app-wide destination rail beside the thread sidebar. */
export const DestinationRail = memo(function DestinationRail() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const active = resolveActiveDestination(pathname);
  const toggleBack = useToggleBack(active);
  const pullRequestsSupported = usePullRequestsSupported();
  const boardAvailable = useKanbanEnvironmentIds().length > 0;
  const notesAvailable = useNotesEnvironmentIds().length > 0;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = useEnvironment(primaryEnvironmentId);
  const canManageProviders = useEnvironmentScope(primaryEnvironmentId, AuthProvidersManageScope);
  const primaryProviderReady = useAtomValue(
    primaryEnvironmentId === null
      ? unknownProviderReadyAtom
      : providerReadyAtom(primaryEnvironmentId),
  );
  const hydration = useClientSettingsHydrationStatus();
  const savedPreferences = useClientSettings((settings) => settings.destinationRail);
  const preferences = railPreferencesForHydration(hydration, savedPreferences);

  const context: RailContext = {
    boardAvailable,
    notesAvailable,
    pullRequestsSupported,
    canAddProvider: primaryEnvironmentId !== null && canManageProviders,
    primaryProviderReady,
  };
  const items = resolveRailItems(preferences ?? DEFAULT_RAIL_PREFERENCES, context);
  const shownItems = items.filter((item) => item.shown);

  // Pinned when opened, and rendered outside the item list, so the wizard survives its rail
  // item hiding once a provider becomes ready mid-setup.
  const [addProviderTarget, setAddProviderTarget] = useState<AddProviderTarget | null>(null);
  const openAddProvider = () => {
    if (primaryEnvironmentId === null) return;
    setAddProviderTarget({
      environmentId: primaryEnvironmentId,
      label: primaryEnvironment?.label ?? "this environment",
    });
  };
  const closeAddProvider = () => {
    setAddProviderTarget(null);
    // The dialog returns focus to its trigger; once that item has hidden, land on the menu.
    if (!document.getElementById(ADD_PROVIDER_BUTTON_ID)) {
      document.getElementById(CUSTOMIZE_RAIL_BUTTON_ID)?.focus();
    }
  };

  return (
    <nav
      aria-label="App"
      className="sticky top-0 z-20 hidden h-[calc(100dvh-var(--status-bar-height,0px))] w-(--destination-rail-width) shrink-0 flex-col items-center bg-background md:flex"
      data-destination-rail=""
      data-glass-pane="rail"
    >
      {/* The titlebar strip above the rail belongs to the window frame. */}
      <div
        aria-hidden
        className={cn("h-(--workspace-topbar-height) w-full shrink-0", isElectron && "drag-region")}
      />
      {/* Scrolls on short windows so the bottom controls stay reachable. */}
      <div className="flex min-h-0 w-full flex-1 scrollbar-gutter-both flex-col items-center gap-1 overflow-y-auto pt-2 pb-3">
        <RailTooltip label="Home">
          <Link
            to="/"
            aria-label="Home"
            activeOptions={EXACT_MATCH}
            aria-current={active === "home" ? "page" : undefined}
            className={railItemClassName(active === "home")}
          >
            <HouseIcon aria-hidden />
          </Link>
        </RailTooltip>
        {preferences === null
          ? null
          : shownItems.map((item, index) => (
              <Fragment key={item.id}>
                <RailItem
                  id={item.id}
                  active={active}
                  toggleBack={toggleBack}
                  onAddProvider={openAddProvider}
                />
                {index === RAIL_DIVIDER_AFTER - 2 && index < shownItems.length - 1 ? (
                  <div aria-hidden className="my-1.5 h-px w-6 shrink-0 bg-border" />
                ) : null}
              </Fragment>
            ))}
        <div className="flex-1" />
        <RailCustomizeMenu items={items} />
        <SidebarForkUpdatePill placement="rail" />
        <SidebarUpdatePill placement="rail" />
        <RailLink
          id="settings"
          to="/settings"
          label="Settings"
          icon={<SettingsIcon aria-hidden />}
          active={active}
          toggleBack={toggleBack}
        />
      </div>
      {addProviderTarget ? (
        <Suspense fallback={null}>
          <AddProviderInstanceDialog
            open
            environmentId={addProviderTarget.environmentId}
            environmentLabel={addProviderTarget.label}
            onOpenChange={(open) => {
              if (!open) closeAddProvider();
            }}
          />
        </Suspense>
      ) : null}
    </nav>
  );
});
