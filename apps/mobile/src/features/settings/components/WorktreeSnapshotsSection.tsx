import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { SettingsSection } from "./SettingsSection";

const PRESET_DAYS = [7, 30, 90] as const;

const snapshotRetentionLabel = (days: number | null) =>
  days === null ? "Keep until I delete them" : `${days} days`;

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
      title="Worktree snapshots"
      footer="Before cleanup removes a worktree it saves your uncommitted and untracked changes. Restore brings them back until they expire."
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
