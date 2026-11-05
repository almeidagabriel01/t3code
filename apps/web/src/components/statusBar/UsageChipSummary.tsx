import type {
  ServerProviderUsageLimits,
  StatusBarUsageMode,
  StatusBarUsagePercentage,
} from "@t3tools/contracts";
import {
  BAND_FILL,
  BAND_TEXT,
  pacePresentation,
  selectUsagePaceSettings,
  windowBand,
  type PaceView,
} from "@t3tools/shared/usagePace";

import { useClientSettings } from "../../hooks/useSettings";
import { selectChipEntries } from "./statusBar.logic";
import { displayedPercent } from "./statusBarItems.logic";
import { UsageBarChip } from "./UsageBarChip";
import { useMinuteNow } from "./useMinuteNow";

const DELTA_TEXT = { deficit: "text-warning", reserve: "text-success" } as const;

export function deltaTone(view: PaceView) {
  return view.deficit ? DELTA_TEXT.deficit : DELTA_TEXT.reserve;
}

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
            delta={
              view === null
                ? null
                : {
                    text: mode === "compact" ? view.deltaText.charAt(0) : view.deltaText,
                    className: deltaTone(view),
                  }
            }
          />
        );
      })}
    </span>
  );
}
