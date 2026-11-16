import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { WORKTREE_SNAPSHOTS_COPY } from "./maintenanceSectionsCopy";
import { SettingsSection } from "./SettingsSection";

const PRESET_DAYS = [7, 30, 90] as const;

const snapshotRetentionLabel = (days: number | null) =>
  days === null ? WORKTREE_SNAPSHOTS_COPY.keepForever : `${days} days`;

/** How long the changes saved before cleanup removes a worktree stay restorable. */
export function WorktreeSnapshotsSection(props: {
  /** Undefined when the selected environments disagree. */
  readonly value: number | null | undefined;
  readonly disabled: boolean;
  readonly onChange: (days: number | null) => void;
}) {
  // A value set elsewhere (web allows any number of days) still shows as selected.
  const choices: ReadonlyArray<number | null> = [
    ...PRESET_DAYS,
    ...(typeof props.value === "number" && !PRESET_DAYS.some((days) => days === props.value)
      ? [props.value]
      : []),
    null,
  ].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  return (
    <SettingsSection
      title={WORKTREE_SNAPSHOTS_COPY.title}
      footer={WORKTREE_SNAPSHOTS_COPY.description}
    >
      {choices.map((days, index) => (
        <ListChoiceRow
          key={days ?? "forever"}
          label={snapshotRetentionLabel(days)}
          selected={props.value === days}
          separated={index > 0}
          disabled={props.disabled}
          onPress={() => props.onChange(days)}
        />
      ))}
    </SettingsSection>
  );
}
