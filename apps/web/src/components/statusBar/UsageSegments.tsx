import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { AuthProvidersManageScope } from "@t3tools/contracts";
import type {
  EnvironmentId,
  InstanceBudgetStatus,
  StatusBarUsageMode,
  StatusBarUsagePercentage,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { RegistryContext } from "@effect/atom-react";
import { useContext, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { usePrimarySettings, useClientSettings } from "../../hooks/useSettings";
import {
  shouldRefreshUsage,
  usageReadingAt,
  USAGE_REFRESH_MS,
} from "@t3tools/shared/statusBarRefresh";
import { budgetPercent, budgetPeriodLabel } from "@t3tools/shared/providerBudget";
import {
  BAND_FILL,
  BAND_TEXT,
  pacePresentation,
  selectUsagePaceSettings,
  weekAllowanceText,
  weekBarSplit,
  windowBand,
  paceTextClass,
} from "@t3tools/shared/usagePace";
import { useProjects, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { RefreshIcon } from "../ui/refresh-icon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { PaceBar } from "./UsageBarChip";
import { ChipSummary } from "./UsageChipSummary";
import {
  displayedPercent,
  isStatusBarItemShown,
  STATUS_BAR_USAGE_ITEM,
} from "./statusBarItems.logic";
import { isApiKeyItem, limitsStatus, type UsageItem } from "./usageItems.logic";
import { formatUsd, TIME_ZONE, useInstanceSpend } from "./useInstanceSpend";
import { collectUsageSessions } from "@t3tools/client-runtime/state/usageSessions";
import { LimitName, ResetText, UsageSessionsList } from "./UsageRosterParts";
import { useUsageItems } from "./useUsageItems";
import { ResetCreditDialog, resetCreditsSummary, useResetCredit } from "../usage/UsageLimits";
import { useEnvironmentScope } from "../../state/session";
import { useMinuteNow } from "./useMinuteNow";

function useUsageRefresh(environmentIds: ReadonlyArray<EnvironmentId>) {
  const registry = useContext(RegistryContext);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const intervalMs = USAGE_REFRESH_MS[useClientSettings((s) => s.statusBarUsageRefresh)];
  const key = environmentIds.join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that pulls usage through the throttled refresh path
  useEffect(() => {
    if (key === "") return;
    const ids = key.split("\n") as EnvironmentId[];
    const refreshedAt = new Map<EnvironmentId, number>();
    const run = (opening = false) => {
      const now = Date.now();
      for (const environmentId of ids) {
        // The reading the server already holds counts: a reload must not probe every provider again.
        const readings = (
          registry.get(serverEnvironment.providersValueAtom(environmentId)) ?? []
        ).flatMap((provider) => (provider.usageLimits ? [provider.usageLimits.checkedAt] : []));
        const lastRefreshAt = Math.max(
          refreshedAt.get(environmentId) ?? 0,
          usageReadingAt(readings),
        );
        if (
          !shouldRefreshUsage({ intervalMs, hidden: document.hidden, lastRefreshAt, now, opening })
        ) {
          continue;
        }
        refreshedAt.set(environmentId, now);
        void refreshUsageLimits(
          environmentId,
          (fresh) => refreshProviders({ environmentId, input: fresh ? { fresh: true } : {} }),
          true,
          false,
          intervalMs ?? undefined,
        );
        registry.refresh(
          serverEnvironment.instanceSpend({ environmentId, input: { timeZone: TIME_ZONE } }),
        );
      }
    };
    run(true);
    if (intervalMs === null) return;
    const check = () => run();
    const timer = setInterval(check, Math.min(intervalMs, 30_000));
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [key, intervalMs, refreshProviders, registry]);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    void Promise.allSettled(
      environmentIds.map((environmentId) =>
        refreshUsageLimits(environmentId, (fresh) =>
          refreshProviders({ environmentId, input: fresh ? { fresh: true } : {} }),
        ),
      ),
    ).finally(() => setRefreshing(false));
  };
  return { refresh, refreshing };
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

/** Thin arc around the icon while any thread on this instance is working. */
function ItemIconWithActivity({ item }: { readonly item: UsageItem }) {
  const threads = useThreadShells();
  const now = useMinuteNow();
  const working = collectUsageSessions({
    threads,
    instanceId: item.entry.instanceId,
    environmentIds: item.environmentIds,
    now,
  }).filter((session) => session.state === "working").length;
  if (working === 0) return <ItemIcon item={item} />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`${item.entry.displayName} working`}
            className="relative inline-flex"
          />
        }
      >
        <ItemIcon item={item} />
        <span
          aria-hidden
          ref={observeVisibleAnimation}
          className="pointer-events-none absolute -inset-0.5 rounded-full border border-transparent border-t-primary motion-safe:visible-animate-spin"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{working} working</TooltipPopup>
    </Tooltip>
  );
}

const BUDGET_TEXT = {
  ok: "",
  warn: "text-warning-foreground",
  exceeded: "text-destructive-foreground",
} as const;
const BUDGET_FILL = {
  ok: "bg-primary",
  warn: "bg-warning-foreground",
  exceeded: "bg-destructive-foreground",
} as const;

function ApiKeyChipValue({ item }: { readonly item: UsageItem }) {
  const spend = useInstanceSpend(item);
  return (
    <span className={cn("tabular-nums", BUDGET_TEXT[spend.budget?.state ?? "ok"])}>
      {formatUsd(spend.todayUsd)}
      {spend.partial ? "+" : ""} today
    </span>
  );
}

/** One toast per instance, period and state, remembered across reloads. */
function useBudgetToast(item: UsageItem, budget: InstanceBudgetStatus | undefined) {
  const state = budget?.state ?? "ok";
  const resetsAt = budget?.resetsAt;
  const name = item.entry.displayName;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one-shot toast and localStorage dedupe are external effects
  useEffect(() => {
    if (state === "ok" || resetsAt === undefined) return;
    const key = `t3:budget-toast:${item.environmentId}:${item.entry.instanceId}:${resetsAt}:`;
    try {
      if (localStorage.getItem(key + state) !== null) return;
      localStorage.setItem(key + state, "1");
      // Jumping straight to exceeded makes the earlier warning redundant.
      if (state === "exceeded") localStorage.setItem(key + "warn", "1");
    } catch {
      return;
    }
    toastManager.add({
      type: state === "exceeded" ? "error" : "warning",
      title: state === "exceeded" ? `${name} is over budget` : `${name} is near its budget`,
    });
  }, [state, resetsAt, name, item.environmentId, item.entry.instanceId]);
}

function ApiKeyBudgetToast({ item }: { readonly item: UsageItem }) {
  useBudgetToast(item, useInstanceSpend(item).budget);
  return null;
}

function BudgetRow({
  item,
  budget,
}: {
  readonly item: UsageItem;
  readonly budget: InstanceBudgetStatus;
}) {
  const now = useMinuteNow();
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <PaceBar
          thin
          usedPercent={budgetPercent(budget)}
          fillClass={BUDGET_FILL[budget.state]}
          tickPercent={null}
          className="min-w-0 flex-1"
        />
        <span className={cn("shrink-0 tabular-nums", BUDGET_TEXT[budget.state])}>
          {budgetPercent(budget)}%
        </span>
        <Button
          variant="ghost-muted"
          size="icon-micro"
          aria-label="Spending budget settings"
          render={
            <Link
              to="/settings/providers"
              search={{ environmentId: item.environmentId, instanceId: item.entry.instanceId }}
              hash="provider-budget"
            />
          }
        >
          <SettingsIcon aria-hidden />
        </Button>
      </span>
      <span className="tabular-nums">
        {formatUsd(budget.spentUsd)} of {formatUsd(budget.amountUsd)}{" "}
        {budgetPeriodLabel(budget, now)}
        {budget.blocking ? (
          <Badge variant="error" size="sm" className="ml-1.5">
            Blocking new turns
          </Badge>
        ) : null}
      </span>
    </div>
  );
}

function ApiKeyRosterDetail({ item }: { readonly item: UsageItem }) {
  const spend = useInstanceSpend(item);
  return (
    <div className="flex flex-col gap-0.5 pl-7.5 text-2xs text-muted-foreground">
      <span className="tabular-nums">
        Today {formatUsd(spend.todayUsd)} · Last 30 days {formatUsd(spend.periodUsd)}
        {spend.partial ? " · partial, some usage could not be priced" : ""}
      </span>
      {spend.budget === undefined ? null : <BudgetRow item={item} budget={spend.budget} />}
      <span>API key, billed per use</span>
    </div>
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
    <span className="inline-flex items-center gap-2">
      <ItemIconWithActivity item={item} />
      {item.environmentLabel === null ? null : (
        <span className="max-w-20 truncate text-muted-foreground">{item.environmentLabel}</span>
      )}
      {isApiKeyItem(item.entry.snapshot) ? (
        <>
          <ApiKeyBudgetToast item={item} />
          <ApiKeyChipValue item={item} />
        </>
      ) : status.kind === "none" ? (
        <span className="text-muted-foreground">--</span>
      ) : (
        <span
          className={cn(
            "inline-flex items-center gap-1.5",
            status.kind === "stale" && "opacity-80",
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
  windows,
  now,
  display,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly now: number;
  readonly display: StatusBarUsagePercentage;
}) {
  const { settings, view } = useWindowPace(window, now, display);
  const resetMode = useClientSettings((settings) => settings.usageResetDisplay);
  const timestampFormat = usePrimarySettings((s) => s.timestampFormat);
  const split = weekBarSplit(window, windows, display);
  const allowance = weekAllowanceText(window);
  const details =
    view === null ? [] : [view.projectionText, view.dailyText].filter((line) => line !== null);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <LimitName window={window} />
        <PaceBar
          thin
          usedPercent={displayedPercent(window.usedPercent, display)}
          fillClass={BAND_FILL[windowBand(window, settings)]}
          tickPercent={view?.tickPercent ?? null}
          split={split && { ...split, remaining: display === "remaining" }}
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
        <ResetText
          window={window}
          now={now}
          mode={resetMode}
          hour12={timestampFormat === "locale" ? undefined : timestampFormat === "12-hour"}
        />
      </span>
      {allowance === null ? null : (
        <span className="pl-15.5 text-3xs text-muted-foreground">{allowance}</span>
      )}
      {view === null ? null : (
        <span className="pl-15.5 text-3xs text-muted-foreground tabular-nums">
          {view.expectedText} · <span className={paceTextClass(view)}>{view.paceText}</span>
          {details.map((line) => ` · ${line}`).join("")}
        </span>
      )}
    </div>
  );
}

function RosterSessions({ item, now }: { readonly item: UsageItem; readonly now: number }) {
  const threads = useThreadShells();
  const projects = useProjects();
  const sessions = collectUsageSessions({
    threads,
    instanceId: item.entry.instanceId,
    environmentIds: item.environmentIds,
    now,
  });
  const titles = new Map(projects.map((p) => [`${p.environmentId}:${p.id}`, p.title]));
  return <UsageSessionsList sessions={sessions} titles={titles} />;
}

function RosterRow({
  item,
  display,
  onRetry,
  onUseReset,
}: {
  readonly item: UsageItem;
  readonly display: StatusBarUsagePercentage;
  readonly onRetry: () => void;
  readonly onUseReset: (item: UsageItem) => void;
}) {
  const now = useMinuteNow();
  const showSessions = useClientSettings((settings) => settings.usageShowSessions);
  const status = limitsStatus(item, now);
  const plan = item.entry.snapshot.auth.label;
  return (
    <div className="flex flex-col gap-1 border-b border-border/50 px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
          <ItemIconWithActivity item={item} />
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
      {isApiKeyItem(item.entry.snapshot) ? (
        <ApiKeyRosterDetail item={item} />
      ) : status.kind === "none" ? (
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
          className={cn("flex flex-col gap-1.5 pl-7.5", status.kind === "stale" && "opacity-80")}
        >
          {status.windows.map((window) => (
            <RosterMetric
              key={window.id}
              window={window}
              windows={status.windows}
              now={now}
              display={display}
            />
          ))}
        </div>
      )}
      <RosterResetCredits item={item} now={now} onUse={onUseReset} />
      {showSessions ? <RosterSessions item={item} now={now} /> : null}
    </div>
  );
}

function RosterResetCredits({
  item,
  now,
  onUse,
}: {
  readonly item: UsageItem;
  readonly now: number;
  readonly onUse: (item: UsageItem) => void;
}) {
  const canManageProviders = useEnvironmentScope(item.environmentId, AuthProvidersManageScope);
  const credits = item.limits?.resetCredits;
  if (!credits || credits.availableCount === 0) return null;
  return (
    <div className="flex items-center gap-2 pl-7.5">
      <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground tabular-nums">
        {resetCreditsSummary(credits, now)}
      </span>
      <Button
        size="xs"
        variant="outline"
        disabled={!canManageProviders}
        onClick={() => onUse(item)}
      >
        Use reset
      </Button>
    </div>
  );
}

/** Mounted outside the popover: popovers stack above dialogs and unmount on close. */
function StatusBarResetDialog({
  item,
  onClose,
}: {
  readonly item: UsageItem;
  readonly onClose: () => void;
}) {
  const { canManageProviders, busy, redeem } = useResetCredit(item.environmentId, {
    instanceId: item.entry.instanceId,
  });
  return (
    <ResetCreditDialog
      open={!busy}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      disabled={!canManageProviders}
      account={item.entry.displayName}
      onConfirm={() =>
        void redeem().then((message) => {
          onClose();
          if (message) toastManager.add({ type: "info", title: message });
        })
      }
    />
  );
}

function UsageSegmentsBody() {
  const { environmentIds, items: allItems } = useUsageItems();
  const hidden = useClientSettings((settings) => settings.statusBarHiddenItems);
  const mode = useClientSettings((settings) => settings.statusBarUsageMode);
  const display = useClientSettings((settings) => settings.statusBarUsagePercentage);
  const { refresh, refreshing } = useUsageRefresh(environmentIds);
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState<UsageItem | null>(null);
  const items = allItems.filter((item) => isStatusBarItemShown(hidden, item.entry.instanceId));
  if (items.length === 0) return null;
  return (
    // Narrow windows clip the chips instead of drawing them over the ports and memory segments.
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {resetting ? (
        <StatusBarResetDialog item={resetting} onClose={() => setResetting(null)} />
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button variant="status-bar" size="status-bar" aria-label="Usage" />}
        >
          <span className="flex items-center gap-5">
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
              <RosterRow
                key={item.key}
                item={item}
                display={display}
                onRetry={refresh}
                onUseReset={(target) => {
                  setOpen(false);
                  setResetting(target);
                }}
              />
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
