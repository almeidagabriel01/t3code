import { useAtomValue } from "@effect/atom-react";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import type {
  EnvironmentId,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { Fragment, useEffect } from "react";

import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  formatCompactCountdown,
  selectBarWindows,
  usageTone,
  type UsageTone,
} from "./statusBar.logic";
import { collectUsageItems, type UsageItem } from "./usageItems.logic";
import { useMinuteNow } from "./useMinuteNow";

const AUTO_REFRESH_MS = 5 * 60_000;

const TONE_TEXT: Record<UsageTone, string> = {
  urgent: "text-destructive",
  warning: "text-warning",
  normal: "",
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
  return () => {
    for (const environmentId of environmentIds) {
      void refreshUsageLimits(environmentId, () => refreshProviders({ environmentId, input: {} }));
    }
  };
}

function MiniBar({ usedPercent }: { readonly usedPercent: number }) {
  return (
    <span className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted">
      <span
        className="block h-full rounded-full bg-muted-foreground/40"
        style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }}
      />
    </span>
  );
}

const windowPercent = (window: ServerProviderUsageWindow) => Math.round(window.usedPercent);

function ChipSummary({ limits }: { readonly limits: ServerProviderUsageLimits }) {
  const now = useMinuteNow();
  const { primary, extra } = selectBarWindows(limits.windows);
  const shown = [
    ...primary.map((window) => ({ window, countdown: true })),
    ...extra.map((window) => ({ window, countdown: false })),
  ];
  const tightest = Math.max(...limits.windows.map((window) => window.usedPercent));
  return (
    <>
      <MiniBar usedPercent={tightest} />
      <span className="flex items-center gap-1 tabular-nums">
        {shown.map(({ window, countdown }, position) => {
          const resets = countdown ? formatCompactCountdown(window.resetsAt, now) : null;
          return (
            <Fragment key={window.id}>
              {position > 0 ? <span className="text-muted-foreground/50">·</span> : null}
              <span className={cn("whitespace-nowrap", TONE_TEXT[usageTone(window.usedPercent)])}>
                {countdown ? "" : `${window.label} `}
                {windowPercent(window)}%{resets ? ` ${resets}` : ""}
              </span>
            </Fragment>
          );
        })}
      </span>
    </>
  );
}

function ItemIcon({ item }: { readonly item: UsageItem }) {
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

function UsageChip({ item }: { readonly item: UsageItem }) {
  const usable = item.limits !== undefined && limitsNotice(item.limits) === null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <ItemIcon item={item} />
      {item.environmentLabel === null ? null : (
        <span className="max-w-20 truncate text-muted-foreground">{item.environmentLabel}</span>
      )}
      {usable && item.limits !== undefined ? (
        <ChipSummary limits={item.limits} />
      ) : (
        <span className="text-muted-foreground/50">--</span>
      )}
    </span>
  );
}

function RosterMetric({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const resets = formatCompactCountdown(window.resetsAt, now);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-3xs text-muted-foreground">{window.label}</span>
      <span className="h-[5px] w-7 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-muted-foreground/60"
          style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
        />
      </span>
      <span className={cn("text-2xs tabular-nums", TONE_TEXT[usageTone(window.usedPercent)])}>
        {windowPercent(window)}%
      </span>
      {resets === null ? null : (
        <span className="text-3xs tabular-nums text-muted-foreground">{resets}</span>
      )}
    </span>
  );
}

function RosterRow({ item }: { readonly item: UsageItem }) {
  const now = useMinuteNow();
  const notice =
    item.limits === undefined
      ? (item.entry.snapshot.message ?? "No usage reported.")
      : limitsNotice(item.limits);
  const windows = item.limits?.windows ?? [];
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
      </div>
      {windows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-7.5">
          {windows.map((window) => (
            <RosterMetric key={window.id} window={window} now={now} />
          ))}
        </div>
      ) : null}
      {notice !== null ? (
        <span className="pl-7.5 text-2xs text-muted-foreground">{notice}</span>
      ) : null}
    </div>
  );
}

export function UsageSegments() {
  const all = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const connected = new Map(
    [...all].filter(([, presentation]) => presentation.connection.phase === "connected"),
  );
  const refresh = useUsageRefresh([...connected.keys()]);
  const items = collectUsageItems(connected);
  if (items.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Popover>
        <PopoverTrigger
          render={<Button variant="status-bar" size="status-bar" aria-label="Usage" />}
        >
          <span className="flex items-center gap-3">
            {items.map((item) => (
              <UsageChip key={item.key} item={item} />
            ))}
          </span>
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" padding="none" className="w-[360px]">
          <div className="flex w-full flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
              <span className="text-2xs font-medium text-foreground">Usage</span>
              <Link to="/usage" className="text-2xs text-muted-foreground hover:text-foreground">
                Open usage page
              </Link>
            </div>
            {items.map((item) => (
              <RosterRow key={item.key} item={item} />
            ))}
          </div>
        </PopoverPopup>
      </Popover>
      <Button variant="ghost-muted" size="icon-micro" aria-label="Refresh usage" onClick={refresh}>
        <RefreshCwIcon aria-hidden />
      </Button>
    </div>
  );
}
