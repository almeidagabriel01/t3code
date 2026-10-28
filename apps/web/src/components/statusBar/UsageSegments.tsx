import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import type {
  EnvironmentId,
  StatusBarUsageMode,
  StatusBarUsagePercentage,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, SettingsIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { usePrimarySettings, useClientSettings } from "../../hooks/useSettings";
import {
  BAND_FILL,
  BAND_TEXT,
  pacePresentation,
  selectUsagePaceSettings,
  windowBand,
  type PaceView,
  type UsagePaceSettings,
} from "@t3tools/shared/usagePace";
import { useProjects, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { RefreshIcon } from "../ui/refresh-icon";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatCompactCountdown, selectBarWindows } from "./statusBar.logic";
import {
  displayedPercent,
  isStatusBarItemShown,
  STATUS_BAR_USAGE_ITEM,
} from "./statusBarItems.logic";
import { limitsStatus, type UsageItem } from "./usageItems.logic";
import {
  collectUsageSessions,
  groupSessionsByProject,
  type UsageSession,
  type UsageSessionState,
} from "@t3tools/client-runtime/state/usageSessions";
import { useUsageItems } from "./useUsageItems";
import { useMinuteNow } from "./useMinuteNow";

const AUTO_REFRESH_MS = 5 * 60_000;

const DELTA_TEXT = { deficit: "text-warning", reserve: "text-success" } as const;
const SESSIONS_SHOWN = 8;
const SESSION_STATE: Record<UsageSessionState, { label: string; dot: string }> = {
  waiting: { label: "Waiting for you", dot: "bg-warning" },
  working: { label: "Working", dot: "bg-success" },
  recent: { label: "Recent", dot: "bg-muted-foreground/40" },
};

function useUsageRefresh(environmentIds: ReadonlyArray<EnvironmentId>) {
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const key = environmentIds.join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that pulls usage through the throttled refresh path
  useEffect(() => {
    if (key === "") return;
    const run = () => {
      for (const environmentId of key.split("\n") as EnvironmentId[]) {
        void refreshUsageLimits(
          environmentId,
          () => refreshProviders({ environmentId, input: {} }),
          true,
        );
      }
    };
    run();
    const timer = setInterval(run, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [key, refreshProviders]);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    void Promise.allSettled(
      environmentIds.map((environmentId) =>
        refreshUsageLimits(environmentId, () => refreshProviders({ environmentId, input: {} })),
      ),
    ).finally(() => setRefreshing(false));
  };
  return { refresh, refreshing };
}

function PaceBar({
  usedPercent,
  fillClass,
  tickPercent,
  className,
  thin = false,
}: {
  readonly usedPercent: number;
  readonly fillClass: string;
  readonly tickPercent: number | null;
  readonly className: string;
  readonly thin?: boolean;
}) {
  return (
    <span
      className={cn(
        "relative shrink-0 rounded-full bg-muted",
        thin ? "h-[5px]" : "h-1.5",
        className,
      )}
    >
      <span className="absolute inset-0 overflow-hidden rounded-full">
        <span
          className={cn("block h-full rounded-full", fillClass)}
          style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }}
        />
      </span>
      {tickPercent === null ? null : (
        <span
          aria-hidden
          className="absolute -inset-y-px w-px -translate-x-1/2 bg-foreground"
          style={{ left: `${Math.min(100, Math.max(0, tickPercent))}%` }}
        />
      )}
    </span>
  );
}

function useWindowPace(
  window: ServerProviderUsageWindow,
  now: number,
  display: StatusBarUsagePercentage,
) {
  const settings = useClientSettings(selectUsagePaceSettings);
  const timestampFormat = usePrimarySettings((s) => s.timestampFormat);
  const view = pacePresentation({
    window,
    now,
    display,
    settings,
    formatAt: (ms) => formatUpcomingTimestamp(new Date(ms).toISOString(), timestampFormat, now),
  });
  return { settings, view };
}

function deltaTone(view: PaceView) {
  return view.deficit ? DELTA_TEXT.deficit : DELTA_TEXT.reserve;
}

function ChipWindow({
  window,
  countdown,
  now,
  display,
  compact,
  settings,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly countdown: boolean;
  readonly now: number;
  readonly display: StatusBarUsagePercentage;
  readonly compact: boolean;
  readonly settings: UsagePaceSettings;
}) {
  const resets = countdown ? formatCompactCountdown(window.resetsAt, now) : null;
  const paceInBar = useClientSettings((current) => current.statusBarUsagePaceVisible);
  const view = paceInBar
    ? pacePresentation({ window, now, display, settings, formatAt: () => "" })
    : null;
  return (
    <span className={cn("whitespace-nowrap", BAND_TEXT[windowBand(window, settings)])}>
      {countdown ? "" : `${window.label} `}
      {displayedPercent(window.usedPercent, display)}%
      {view === null ? null : (
        <span className={cn("text-3xs", deltaTone(view))}>
          {" "}
          {compact ? view.deltaText.charAt(0) : view.deltaText}
        </span>
      )}
      {resets ? ` ${resets}` : ""}
    </span>
  );
}

function ChipSummary({
  limits,
  mode,
  display,
}: {
  readonly limits: ServerProviderUsageLimits;
  readonly mode: StatusBarUsageMode;
  readonly display: StatusBarUsagePercentage;
}) {
  const now = useMinuteNow();
  const settings = useClientSettings(selectUsagePaceSettings);
  const paceInBar = useClientSettings((current) => current.statusBarUsagePaceVisible);
  const tightest = limits.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  const { primary, extra } = selectBarWindows(limits.windows);
  const shown =
    mode === "compact"
      ? [{ window: tightest, countdown: true }]
      : [
          ...primary.map((window) => ({ window, countdown: true })),
          ...extra.map((window) => ({ window, countdown: false })),
        ];
  const tightestPace = pacePresentation({
    window: tightest,
    now,
    display,
    settings,
    formatAt: () => "",
  });
  return (
    <>
      {mode === "verbose" ? (
        <PaceBar
          usedPercent={displayedPercent(tightest.usedPercent, display)}
          fillClass={BAND_FILL[windowBand(tightest, settings)]}
          tickPercent={paceInBar ? (tightestPace?.tickPercent ?? null) : null}
          className="w-12"
        />
      ) : null}
      <span className="flex items-center gap-1 tabular-nums">
        {shown.map(({ window, countdown }, position) => (
          <Fragment key={window.id}>
            {position > 0 ? <span className="text-muted-foreground/50">·</span> : null}
            <ChipWindow
              window={window}
              countdown={countdown}
              now={now}
              display={display}
              compact={mode === "compact"}
              settings={settings}
            />
          </Fragment>
        ))}
      </span>
    </>
  );
}

export function ItemIcon({ item }: { readonly item: UsageItem }) {
  const { entry } = item;
  return (
    <ProviderInstanceIcon
      driverKind={entry.driverKind}
      displayName={entry.displayName}
      accentColor={entry.accentColor}
      acpRegistryAgentId={entry.acpRegistryAgentId}
      acpRegistryIconUrl={entry.acpRegistryIconUrl}
      showBadge={item.showBadge}
      badgeContent="initials"
      size="compact"
      indicatorBackground="var(--card)"
    />
  );
}

function UsageChip({
  item,
  mode,
  display,
}: {
  readonly item: UsageItem;
  readonly mode: StatusBarUsageMode;
  readonly display: StatusBarUsagePercentage;
}) {
  const now = useMinuteNow();
  const status = limitsStatus(item, now);
  return (
    <span className="inline-flex items-center gap-1.5">
      <ItemIcon item={item} />
      {item.environmentLabel === null ? null : (
        <span className="max-w-20 truncate text-muted-foreground">{item.environmentLabel}</span>
      )}
      {status.kind === "none" ? (
        <span className="text-muted-foreground/50">--</span>
      ) : (
        <span
          className={cn(
            "inline-flex items-center gap-1.5",
            status.kind === "stale" && "opacity-60",
          )}
        >
          <ChipSummary
            limits={{ checkedAt: status.checkedAt, windows: status.windows }}
            mode={mode}
            display={display}
          />
        </span>
      )}
    </span>
  );
}

function RosterMetric({
  window,
  now,
  display,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly display: StatusBarUsagePercentage;
}) {
  const { settings, view } = useWindowPace(window, now, display);
  const resets = formatCompactCountdown(window.resetsAt, now);
  const details =
    view === null ? [] : [view.projectionText, view.dailyText].filter((line) => line !== null);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <span className="w-14 shrink-0 truncate text-3xs text-muted-foreground">
          {window.label}
        </span>
        <PaceBar
          thin
          usedPercent={displayedPercent(window.usedPercent, display)}
          fillClass={BAND_FILL[windowBand(window, settings)]}
          tickPercent={view?.tickPercent ?? null}
          className="min-w-0 flex-1"
        />
        <span
          className={cn(
            "w-8 shrink-0 text-end text-2xs tabular-nums",
            BAND_TEXT[windowBand(window, settings)],
          )}
        >
          {displayedPercent(window.usedPercent, display)}%
        </span>
        <span className="w-12 shrink-0 text-end text-3xs tabular-nums text-muted-foreground">
          {resets ?? ""}
        </span>
      </span>
      {view === null ? null : (
        <span className="pl-15.5 text-3xs text-muted-foreground tabular-nums">
          {view.expectedText} · <span className={deltaTone(view)}>{view.paceText}</span>
          {details.map((line) => ` · ${line}`).join("")}
        </span>
      )}
    </div>
  );
}

function SessionRow({ session }: { readonly session: UsageSession }) {
  const navigate = useNavigate();
  const state = SESSION_STATE[session.state];
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-start hover:bg-accent"
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(session.environmentId, session.threadId)),
        })
      }
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", state.dot)} />
      <span className="min-w-0 flex-1 truncate text-2xs text-foreground">{session.title}</span>
      <span className="shrink-0 text-3xs text-muted-foreground">{state.label}</span>
      <span className="max-w-24 shrink-0 truncate text-3xs text-muted-foreground">
        {session.model}
      </span>
      <span className="w-12 shrink-0 text-end text-3xs tabular-nums text-muted-foreground">
        {session.elapsed}
      </span>
    </button>
  );
}

function RosterSessions({ item, now }: { readonly item: UsageItem; readonly now: number }) {
  const threads = useThreadShells();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const sessions = collectUsageSessions({
    threads,
    instanceId: item.entry.instanceId,
    environmentIds: item.environmentIds,
    now,
  });
  if (sessions.length === 0) return null;
  const visible = showAll ? sessions : sessions.slice(0, SESSIONS_SHOWN);
  const titles = new Map(projects.map((p) => [`${p.environmentId}:${p.id}`, p.title]));
  return (
    <div className="flex flex-col gap-0.5 pl-7.5">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-fit items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        <ChevronRightIcon aria-hidden className={cn("size-3", open && "rotate-90")} />
        Sessions ({sessions.length})
      </button>
      {open ? (
        <div className="flex flex-col gap-1">
          {groupSessionsByProject(visible).map((group) => (
            <div key={group.projectKey} className="flex flex-col">
              <span className="truncate px-1 text-3xs font-medium text-muted-foreground">
                {titles.get(group.projectKey) ?? "Project"}
              </span>
              {group.sessions.map((session) => (
                <SessionRow
                  key={`${session.environmentId}:${session.threadId}`}
                  session={session}
                />
              ))}
            </div>
          ))}
          {sessions.length > visible.length ? (
            <button
              type="button"
              className="w-fit px-1 text-3xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAll(true)}
            >
              and {sessions.length - visible.length} more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RosterRow({
  item,
  display,
  onRetry,
}: {
  readonly item: UsageItem;
  readonly display: StatusBarUsagePercentage;
  readonly onRetry: () => void;
}) {
  const now = useMinuteNow();
  const showSessions = useClientSettings((settings) => settings.usageShowSessions);
  const status = limitsStatus(item, now);
  const plan = item.entry.snapshot.auth.label;
  return (
    <div className="flex flex-col gap-1 border-b border-border/50 px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
          <ItemIcon item={item} />
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {item.entry.displayName}
          {plan ? <span className="font-normal text-muted-foreground"> · {plan}</span> : null}
          {item.environmentLabel === null ? null : (
            <span className="font-normal text-muted-foreground"> · {item.environmentLabel}</span>
          )}
        </span>
        {status.kind === "stale" ? (
          <span className="ml-auto shrink-0 text-3xs text-muted-foreground">
            as of{" "}
            {new Date(status.checkedAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        ) : null}
      </div>
      {status.kind === "none" ? (
        <div className="flex items-center gap-2 pl-7.5">
          <span className="min-w-0 flex-1 text-2xs text-muted-foreground">{status.message}</span>
          {status.canRetry ? (
            <Button variant="ghost-muted" size="micro" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          className={cn("flex flex-col gap-1.5 pl-7.5", status.kind === "stale" && "opacity-60")}
        >
          {status.windows.map((window) => (
            <RosterMetric key={window.id} window={window} now={now} display={display} />
          ))}
        </div>
      )}
      {showSessions ? <RosterSessions item={item} now={now} /> : null}
    </div>
  );
}

function UsageSegmentsBody() {
  const { environmentIds, items: allItems } = useUsageItems();
  const hidden = useClientSettings((settings) => settings.statusBarHiddenItems);
  const mode = useClientSettings((settings) => settings.statusBarUsageMode);
  const display = useClientSettings((settings) => settings.statusBarUsagePercentage);
  const { refresh, refreshing } = useUsageRefresh(environmentIds);
  const items = allItems.filter((item) => isStatusBarItemShown(hidden, item.entry.instanceId));
  if (items.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Popover>
        <PopoverTrigger
          render={<Button variant="status-bar" size="status-bar" aria-label="Usage" />}
        >
          <span className="flex items-center gap-3">
            {items.map((item) => (
              <UsageChip key={item.key} item={item} mode={mode} display={display} />
            ))}
          </span>
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" padding="none" className="w-[400px]">
          <div className="flex w-full flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
              <span className="text-2xs font-medium text-foreground">Usage</span>
              <div className="flex items-center gap-1">
                <Link to="/usage" className="text-2xs text-muted-foreground hover:text-foreground">
                  Open usage page
                </Link>
                <Button
                  variant="ghost-muted"
                  size="icon-micro"
                  aria-label="Status bar settings"
                  render={<Link to="/settings/status-bar" hash="status-bar-usage" />}
                >
                  <SettingsIcon aria-hidden />
                </Button>
              </div>
            </div>
            {items.map((item) => (
              <RosterRow key={item.key} item={item} display={display} onRetry={refresh} />
            ))}
          </div>
        </PopoverPopup>
      </Popover>
      <Button
        variant="ghost-muted"
        size="icon-micro"
        aria-label={refreshing ? "Refreshing usage" : "Refresh usage"}
        aria-busy={refreshing}
        onClick={refresh}
      >
        <RefreshIcon refreshing={refreshing} />
      </Button>
    </div>
  );
}

export function UsageSegments() {
  const hidden = useClientSettings((settings) => settings.statusBarHiddenItems);
  return isStatusBarItemShown(hidden, STATUS_BAR_USAGE_ITEM) ? <UsageSegmentsBody /> : null;
}
