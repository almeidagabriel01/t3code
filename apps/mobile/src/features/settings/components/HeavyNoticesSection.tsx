import { HEAVY_NOTICES_MODE_OPTIONS, type HeavyNoticesMode } from "@t3tools/contracts";

import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { SettingsSection } from "./SettingsSection";

/** Which heavy job problems and machine changes show as toasts. */
export function HeavyNoticesSection(props: {
  /** Null when the selected environments disagree. */
  readonly value: HeavyNoticesMode | null;
  readonly disabled: boolean;
  readonly onChange: (mode: HeavyNoticesMode) => void;
}) {
  return (
    <SettingsSection
      title="Heavy job notices"
      footer="Toasts when a heavy job fails, gets stuck or runs on another machine than planned, on this Mac or Linux."
    >
      {HEAVY_NOTICES_MODE_OPTIONS.map((option, index) => (
        <ListChoiceRow
          key={option.value}
          label={option.label}
          description={option.description}
          selected={props.value === option.value}
          separated={index > 0}
          disabled={props.disabled}
          onPress={() => props.onChange(option.value)}
        />
      ))}
    </SettingsSection>
  );
}
