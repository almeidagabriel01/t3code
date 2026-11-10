import type {
  ServerProviderUsageLimits,
  StatusBarUsageMode,
  StatusBarUsagePercentage,
} from "@t3tools/contracts";
import {
  BAND_FILL,
  BAND_TEXT,
  pacePresentation,
  paceTextClass,
  selectUsagePaceSettings,
  weekBarSplit,
  windowBand,
} from "@t3tools/shared/usagePace";

import { useClientSettings } from "../../hooks/useSettings";
import { selectChipEntries } from "./statusBar.logic";
import { displayedPercent } from "./statusBarItems.logic";
import { UsageBarChip } from "./UsageBarChip";
import { useMinuteNow } from "./useMinuteNow";

export function ChipSummary({
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
  const entries = selectChipEntries(limits.windows, mode, now);
  return (
    <span className="flex items-center tabular-nums">
      {entries.map((entry, index) => {
        const { window } = entry;
        const view = paceInBar
          ? pacePresentation({ window, now, display, settings, formatAt: () => "" })
          : null;
        const band = windowBand(window, settings);
        const split = entry.bar ? weekBarSplit(window, limits.windows, display) : null;
        return (
          <UsageBarChip
            key={window.id}
            percent={displayedPercent(window.usedPercent, display)}
            name={entry.name}
            resets={entry.resets}
            bar={entry.bar}
            extra={!entry.bar && mode === "verbose"}
            divider={index > 0}
            fillClass={BAND_FILL[band]}
            textClass={BAND_TEXT[band]}
            tickPercent={view?.tickPercent ?? null}
            split={split && { ...split, remaining: display === "remaining" }}
            delta={
              view === null
                ? null
                : {
                    text: mode === "compact" ? view.deltaText.charAt(0) : view.deltaText,
                    className: paceTextClass(view),
                  }
            }
          />
        );
      })}
    </span>
  );
}
