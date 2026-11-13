import {
  MERGED_WORKTREE_DAYS,
  type ServerSettingsPatch,
  type WorktreeCleanupRules,
  type WorktreeMergedCleanup,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup, worktreeCleanupDeletes } from "@t3tools/shared/projectSettings";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import type { ScopedMobileSettingsTarget } from "../settings-scoped-server";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const MERGED_LABELS: Record<WorktreeMergedCleanup, string> = {
  off: "Off",
  "right-away": "Right away",
  "after-days": "After",
};

const KEEP_WHEN_CHOICES = [
  {
    value: "any-local-files",
    label: "Any local files",
    description: "Includes ignored files, except node_modules.",
  },
  {
    value: "uncommitted-changes",
    label: "Uncommitted changes",
    description: "Keeps edits and untracked files. Deletes ignored files, including .env.",
  },
  {
    value: "tracked-changes",
    label: "Edited tracked files",
    description: "Deletes untracked and ignored files, including .env.",
  },
] as const;

const PROJECT_MODES = [
  {
    mode: "inherit",
    label: "Inherit",
    description: "Use each machine's worktree cleanup settings.",
  },
  {
    mode: "off",
    label: "Off",
    description: "Keep this project's worktrees until you delete them manually.",
  },
  { mode: "custom", label: "Custom", description: "Use these rules for this project." },
] as const;

const MAX_DAYS = 3650;

/** Saved on end of editing; a value out of range shows its error and is never sent. */
function DaysField(props: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly disabled: boolean;
  readonly onSave: (days: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.value));
  const days = Number(draft);
  const valid =
    /^\d+$/.test(draft.trim()) && Number.isInteger(days) && days >= props.min && days <= props.max;
  return (
    <View className="gap-1 border-t border-border-subtle px-4 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-base text-foreground">{props.label}</Text>
        <AppTextInput
          accessibilityLabel={props.label}
          value={draft}
          onChangeText={setDraft}
          onEndEditing={() => {
            if (valid && days !== props.value) props.onSave(days);
          }}
          keyboardType="number-pad"
          editable={!props.disabled}
          className="min-h-10 w-24 rounded-xl px-3 py-2 text-right"
        />
      </View>
      {valid ? null : (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          Enter a whole number of days from {props.min} to {props.max}.
        </Text>
      )}
    </View>
  );
}

/** Days or Off: Off clears the rule, turning it on starts from `start`. */
function RetentionRows(props: {
  readonly label: string;
  readonly description: string;
  readonly value: number | null | undefined;
  readonly min: number;
  readonly start: number;
  readonly disabled: boolean;
  readonly onChange: (days: number | null) => void;
}) {
  return (
    <SettingsSection>
      <SettingsSwitchRow
        icon="clock"
        label={props.label}
        subtitle={props.description}
        value={props.value === undefined ? null : props.value !== null}
        disabled={props.disabled}
        onValueChange={(on) => props.onChange(on ? props.start : null)}
      />
      {typeof props.value === "number" ? (
        <DaysField
          key={props.value}
          label="Days"
          value={props.value}
          min={props.min}
          max={MAX_DAYS}
          disabled={props.disabled}
          onSave={props.onChange}
        />
      ) : null}
    </SettingsSection>
  );
}

/** Automatic worktree cleanup rules for the machines, or for the selected projects. */
export function WorktreeCleanupSections(props: {
  readonly targets: readonly ScopedMobileSettingsTarget[];
  readonly projectSelected: boolean;
  readonly disabledFor: (key: string) => boolean;
  readonly managed: (key: string) => string | undefined;
  readonly write: (patch: ServerSettingsPatch) => void;
  readonly clearProjectCleanup: () => void;
}) {
  const { targets, projectSelected } = props;
  const capability = (
    key: "projectWorktreeCleanup" | "settledWorktreeCleanup" | "mergedWorktreeCleanup",
  ) =>
    targets.every(
      (target) => target.environment.serverConfig.environment.capabilities[key] === true,
    );
  if (projectSelected && !capability("projectWorktreeCleanup"))
    return (
      <Text className="px-2 text-sm text-foreground-muted">
        Update the selected machines to configure project worktree cleanup.
      </Text>
    );

  const perTarget = targets.map((target) =>
    resolveWorktreeCleanup(target.environment.serverConfig.settings, target.projectId),
  );
  const rules = perTarget[0]!;
  const mixed = (key: keyof WorktreeCleanupRules) =>
    perTarget.some((entry) => entry[key] !== rules[key]);
  const modes = targets.map((target) => target.settings.worktreeCleanup?.mode ?? "inherit");
  const modesMixed = modes.some((mode) => mode !== modes[0]);
  const lock = (key: keyof WorktreeCleanupRules) =>
    props.disabledFor(projectSelected ? "worktreeCleanup" : `storageCleanup.${key}`);
  const reason = (key: keyof WorktreeCleanupRules) =>
    props.managed(projectSelected ? "worktreeCleanup" : `storageCleanup.${key}`);
  const describe = (key: keyof WorktreeCleanupRules, text: string) => {
    const managed = reason(key);
    return managed === undefined ? text : `${text} ${managed}`;
  };
  const update = (patch: Partial<WorktreeCleanupRules>) =>
    props.write(
      projectSelected
        ? { worktreeCleanup: { mode: "custom", rules: patch } }
        : { storageCleanup: patch },
    );
  const showRules = !projectSelected || (!modesMixed && modes[0] === "custom");
  const mergedSupported = capability("mergedWorktreeCleanup");
  const settledSupported = capability("settledWorktreeCleanup");
  const mixedLabel = <Text className="px-2 text-sm text-foreground-muted">Mixed</Text>;

  return (
    <>
      {projectSelected ? (
        <SettingsSection
          title="Automatic worktree cleanup"
          trailing={modesMixed ? mixedLabel : null}
          footer={props.managed("worktreeCleanup")}
        >
          {PROJECT_MODES.map((choice, index) => (
            <ListChoiceRow
              key={choice.mode}
              label={choice.label}
              description={choice.description}
              selected={!modesMixed && modes[0] === choice.mode}
              separated={index > 0}
              disabled={props.disabledFor("worktreeCleanup")}
              onPress={() => {
                if (choice.mode === "inherit") props.clearProjectCleanup();
                else if (choice.mode === "off") props.write({ worktreeCleanup: { mode: "off" } });
                else props.write({ worktreeCleanup: { mode: "custom", rules: {} } });
              }}
            />
          ))}
        </SettingsSection>
      ) : null}
      {showRules ? (
        <>
          <SettingsSection>
            <SettingsSwitchRow
              icon="trash"
              label="Delete worktrees with deleted threads"
              subtitle={describe(
                "worktreeOnDelete",
                "Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept.",
              )}
              value={mixed("worktreeOnDelete") ? null : rules.worktreeOnDelete}
              disabled={lock("worktreeOnDelete")}
              onValueChange={(worktreeOnDelete) => update({ worktreeOnDelete })}
            />
          </SettingsSection>
          {mergedSupported ? (
            <SettingsSection
              title="Delete merged worktrees"
              trailing={mixed("worktreeMerged") ? mixedLabel : null}
              footer={describe(
                "worktreeMerged",
                "Remove worktrees whose commits are already in the default branch, merged locally or through a pull request.",
              )}
            >
              {(["off", "right-away", "after-days"] as const).map((option, index) => (
                <ListChoiceRow
                  key={option}
                  label={
                    option === "after-days"
                      ? `${MERGED_LABELS[option]} ${rules.worktreeMergedAfterDays} days`
                      : MERGED_LABELS[option]
                  }
                  selected={!mixed("worktreeMerged") && rules.worktreeMerged === option}
                  separated={index > 0}
                  disabled={lock("worktreeMerged")}
                  onPress={() => update({ worktreeMerged: option })}
                />
              ))}
              {rules.worktreeMerged === "after-days" && !mixed("worktreeMerged") ? (
                <DaysField
                  key={rules.worktreeMergedAfterDays}
                  label="Days unused"
                  value={rules.worktreeMergedAfterDays}
                  min={MERGED_WORKTREE_DAYS.minimum}
                  max={MERGED_WORKTREE_DAYS.maximum}
                  disabled={lock("worktreeMergedAfterDays")}
                  onSave={(worktreeMergedAfterDays) => update({ worktreeMergedAfterDays })}
                />
              ) : null}
            </SettingsSection>
          ) : (
            <Text className="px-2 text-sm text-foreground-muted">
              Update the selected machines to change merged worktree cleanup.
            </Text>
          )}
          <RetentionRows
            label="Delete inactive worktrees"
            description={describe(
              "worktreeAfterDays",
              "Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept.",
            )}
            value={mixed("worktreeAfterDays") ? undefined : rules.worktreeAfterDays}
            min={1}
            start={8}
            disabled={lock("worktreeAfterDays")}
            onChange={(worktreeAfterDays) => update({ worktreeAfterDays })}
          />
          {settledSupported ? (
            <RetentionRows
              label="Delete settled worktrees"
              description={describe(
                "worktreeSettledAfterDays",
                "Remove worktrees this many days after their thread settles. Set 0 days to remove them at the next cleanup. Branches and thread history are kept.",
              )}
              value={mixed("worktreeSettledAfterDays") ? undefined : rules.worktreeSettledAfterDays}
              min={0}
              start={8}
              disabled={lock("worktreeSettledAfterDays")}
              onChange={(worktreeSettledAfterDays) => update({ worktreeSettledAfterDays })}
            />
          ) : null}
          {mergedSupported && perTarget.some(worktreeCleanupDeletes) ? (
            <SettingsSection>
              <SettingsSwitchRow
                icon="internaldrive"
                label="Delete the Linux copy too"
                subtitle={describe(
                  "worktreeRunnerCopy",
                  "When cleanup deletes a worktree, also delete its copy on the Runner's Linux machine.",
                )}
                value={mixed("worktreeRunnerCopy") ? null : rules.worktreeRunnerCopy}
                disabled={lock("worktreeRunnerCopy")}
                onValueChange={(worktreeRunnerCopy) => update({ worktreeRunnerCopy })}
              />
            </SettingsSection>
          ) : null}
          <SettingsSection
            title="Keep worktrees with"
            trailing={mixed("worktreeKeepWhen") ? mixedLabel : null}
            footer={reason("worktreeKeepWhen")}
          >
            {KEEP_WHEN_CHOICES.map((choice, index) => (
              <ListChoiceRow
                key={choice.value}
                label={choice.label}
                description={choice.description}
                selected={!mixed("worktreeKeepWhen") && rules.worktreeKeepWhen === choice.value}
                separated={index > 0}
                disabled={lock("worktreeKeepWhen")}
                onPress={() => update({ worktreeKeepWhen: choice.value })}
              />
            ))}
          </SettingsSection>
        </>
      ) : null}
    </>
  );
}
