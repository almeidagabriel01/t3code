import { KEEP_AWAKE_MODES, type EnvironmentId, type KeepAwakeMode } from "@t3tools/contracts";

import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { useKeepAwakeStatus } from "../../../state/keepAwake";
import { KEEP_AWAKE_COPY } from "./maintenanceSectionsCopy";
import { SettingsSection } from "./SettingsSection";

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
      title={KEEP_AWAKE_COPY.title}
      footer={
        unsupported
          ? `${KEEP_AWAKE_COPY.note}\n\n${KEEP_AWAKE_COPY.unsupported}`
          : KEEP_AWAKE_COPY.note
      }
    >
      {KEEP_AWAKE_MODES.map((mode, index) => (
        <ListChoiceRow
          key={mode}
          label={KEEP_AWAKE_COPY.modes[mode]}
          selected={props.value === mode}
          separated={index > 0}
          disabled={props.disabled || unsupported}
          onPress={() => props.onChange(mode)}
        />
      ))}
    </SettingsSection>
  );
}
