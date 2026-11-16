import { HEAVY_NOTICES_COPY } from "@t3tools/client-runtime/state/runnerModel";
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
    <SettingsSection title={HEAVY_NOTICES_COPY.title} footer={HEAVY_NOTICES_COPY.description}>
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
