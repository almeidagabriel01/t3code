import { useAtomValue } from "@effect/atom-react";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import type {
  EnvironmentId,
  ServerConfig,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { collectLimitAccounts, limitsNotice } from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect } from "react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  shouldShowInstanceBadge,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { LimitWindows } from "../usage/UsageLimits";
import { formatCompactCountdown, selectBarWindows } from "./statusBar.logic";
import { useMinuteNow } from "./useMinuteNow";

const AUTO_REFRESH_MS = 5 * 60_000;

function useAutomaticUsageRefresh(environmentIds: ReadonlyArray<EnvironmentId>) {
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const key = environmentIds.join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that pulls usage through the throttled refresh path
  useEffect(() => {
    if (key === "") return;
    const ids = key.split("\n") as EnvironmentId[];
    const refresh = () => {
      for (const environmentId of ids) {
        void refreshUsageLimits(
          environmentId,
          () => refreshProviders({ environmentId, input: {} }),
          true,
        );
      }
    };
    refresh();
    const timer = setInterval(refresh, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [key, refreshProviders]);
}

function WindowSummary({
  window,
  now,
  countdown,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly countdown: boolean;
}) {
  const resets = countdown ? formatCompactCountdown(window.resetsAt, now) : null;
  return (
    <span className="whitespace-nowrap">
      {countdown ? "" : `${window.label} `}
      {Math.round(window.usedPercent)}%{resets ? ` ${resets}` : ""}
    </span>
  );
}

function UsageSummary({ limits }: { readonly limits: ServerProviderUsageLimits }) {
  const now = useMinuteNow();
  if (limits.unavailable !== undefined || limits.windows.length === 0) {
    return <span className="text-muted-foreground">n/a</span>;
  }
  const { primary, extra } = selectBarWindows(limits.windows);
  const shown = [
    ...primary.map((window) => ({ window, countdown: true })),
    ...extra.map((window) => ({ window, countdown: false })),
  ];
  return (
    <span className="flex items-center gap-1 tabular-nums">
      {shown.map(({ window, countdown }, position) => (
        <Fragment key={window.id}>
          {position > 0 ? <span>·</span> : null}
          <WindowSummary window={window} now={now} countdown={countdown} />
        </Fragment>
      ))}
    </span>
  );
}

function UsageDetails({
  entry,
  limits,
  environmentLabel,
}: {
  readonly entry: ProviderInstanceEntry;
  readonly limits: ServerProviderUsageLimits;
  readonly environmentLabel: string | null;
}) {
  const now = useMinuteNow();
  const notice = limitsNotice(limits);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <span className="font-medium text-foreground">
        {entry.displayName}
        {environmentLabel === null ? "" : ` · ${environmentLabel}`}
      </span>
      {limits.windows.length > 0 ? (
        <LimitWindows driver={entry.driverKind} windows={limits.windows} now={now} compact />
      ) : null}
      {notice !== null ? <span className="text-muted-foreground">{notice}</span> : null}
      <Link to="/usage" className="text-muted-foreground underline-offset-4 hover:underline">
        Open usage
      </Link>
    </div>
  );
}

interface UsageItem {
  readonly key: string;
  readonly entry: ProviderInstanceEntry;
  readonly limits: ServerProviderUsageLimits;
  readonly showBadge: boolean;
  /** Set only while more than one environment is connected. */
  readonly environmentLabel: string | null;
}

function UsageEntry({ item }: { readonly item: UsageItem }) {
  const { entry, limits, environmentLabel } = item;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost-muted" size="micro" aria-label={`${entry.displayName} usage`} />
        }
      >
        <ProviderInstanceIcon
          driverKind={entry.driverKind}
          displayName={entry.displayName}
          accentColor={entry.accentColor}
          acpRegistryAgentId={entry.acpRegistryAgentId}
          acpRegistryIconUrl={entry.acpRegistryIconUrl}
          showBadge={item.showBadge}
          badgeContent="initials"
          size="compact"
          indicatorBackground="var(--background)"
        />
        {environmentLabel === null ? null : (
          <span className="max-w-24 truncate">{environmentLabel}</span>
        )}
        <UsageSummary limits={limits} />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" width="lg">
        <UsageDetails entry={entry} limits={limits} environmentLabel={environmentLabel} />
      </PopoverPopup>
    </Popover>
  );
}

/** Accounts shared by several environments appear once; instances with no readable limits appear as unavailable. */
type UsagePresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: Pick<
      ServerConfig,
      "providers" | "settings" | "usageLimitSources"
    > | null;
  }
>;

function collectUsageItems(presentations: UsagePresentations): ReadonlyArray<UsageItem> {
  const labelEnvironments = presentations.size > 1;
  const entriesByKey = new Map<
    string,
    { entry: ProviderInstanceEntry; siblings: ReadonlyArray<ProviderInstanceEntry>; label: string }
  >();
  for (const [environmentId, presentation] of presentations) {
    const config = presentation.serverConfig;
    if (config === null) continue;
    const entries = sortProviderInstanceEntries(
      applyProviderInstanceSettings(
        deriveProviderInstanceEntries(config.providers),
        config.settings,
        null,
      ),
    );
    for (const entry of entries) {
      entriesByKey.set(`${environmentId}:${entry.instanceId}`, {
        entry,
        siblings: entries,
        label: presentation.entry.target.label,
      });
    }
  }
  const shared = collectLimitAccounts(presentations).flatMap((account) => {
    const found = entriesByKey.get(account.key);
    return found === undefined || !found.entry.enabled
      ? []
      : [
          {
            key: account.key,
            entry: found.entry,
            limits: account.limits,
            showBadge: shouldShowInstanceBadge(found.entry, found.siblings),
            environmentLabel: labelEnvironments
              ? account.environments.map(({ label }) => label).join(", ")
              : null,
          },
        ];
  });
  const unavailable = [...entriesByKey].flatMap(([key, { entry, siblings, label }]) => {
    const limits = entry.snapshot.usageLimits;
    return entry.enabled && limits !== undefined && limitsNotice(limits) !== null
      ? [
          {
            key,
            entry,
            limits,
            showBadge: shouldShowInstanceBadge(entry, siblings),
            environmentLabel: labelEnvironments ? label : null,
          },
        ]
      : [];
  });
  return [...shared, ...unavailable];
}

export function UsageSegments() {
  const all = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const connected = new Map(
    [...all].filter(([, presentation]) => presentation.connection.phase === "connected"),
  );
  useAutomaticUsageRefresh([...connected.keys()]);
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden">
      {collectUsageItems(connected).map((item) => (
        <UsageEntry key={item.key} item={item} />
      ))}
    </div>
  );
}
