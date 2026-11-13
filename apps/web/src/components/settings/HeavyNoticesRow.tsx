import { HEAVY_NOTICES_MODE_OPTIONS, type HeavyNoticesMode } from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const labelOf = (mode: HeavyNoticesMode) =>
  HEAVY_NOTICES_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;

/** Which heavy job problems and machine changes show as toasts on every client. */
export function HeavyNoticesRow() {
  const mode = useScopedSettings((settings) => settings.heavyNotices);
  const update = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("heavy-work-notices")}
      description="Toasts when a heavy job fails, gets stuck or runs on another machine than planned, on this Mac or Linux."
      control={
        <Select
          value={mode}
          onValueChange={(next) => {
            if (next !== null) update({ heavyNotices: next as HeavyNoticesMode });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-64" aria-label="Heavy job notices">
            <SelectValue>{labelOf(mode)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {HEAVY_NOTICES_MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex flex-col">
                  <span>{option.label}</span>
                  <span className="text-muted-foreground text-xs">{option.description}</span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
