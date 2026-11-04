import { KEEP_AWAKE_MODES, type EnvironmentId, type KeepAwakeMode } from "@t3tools/contracts";

import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { useKeepAwakeStatus } from "../../../state/keepAwake";
import { SettingsSection } from "./SettingsSection";

const LABELS: Record<KeepAwakeMode, string> = {
  off: "Off",
  "while-working": "While agents are working",
  always: "Always",
};

const NOTE =
  "Your computer can't run agents while it sleeps. Closing a laptop lid still puts it to sleep unless it is plugged in with an external display.";

export function KeepAwakeSection(props: {
  readonly environmentId: EnvironmentId;
  /** Null when the selected environments disagree. */
  readonly value: KeepAwakeMode | null;
  readonly disabled: boolean;
  readonly onChange: (mode: KeepAwakeMode) => void;
}) {
  const unsupported = useKeepAwakeStatus(props.environmentId)?.supported === false;
  return (
    <SettingsSection
      title="Keep this computer awake"
      footer={unsupported ? `${NOTE}\n\nNot available on this system` : NOTE}
    >
      {KEEP_AWAKE_MODES.map((mode, index) => (
        <ListChoiceRow
          key={mode}
          label={LABELS[mode]}
          selected={props.value === mode}
          separated={index > 0}
          disabled={props.disabled || unsupported}
          onPress={() => props.onChange(mode)}
        />
      ))}
    </SettingsSection>
  );
}
