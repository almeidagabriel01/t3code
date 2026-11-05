import {
  AUTONOMY_CHANNEL_LABELS,
  AUTONOMY_RULE_OPTIONS,
  toggleInList,
} from "@t3tools/client-runtime/autonomy";
import type {
  AssistantAutonomy,
  AutonomyChannel,
  AutonomyMode,
  AutonomyRule,
  AutonomySettings,
  ProjectId,
} from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListSection } from "../../components/ui/ListSection";
import { ChoiceRow, FieldHeader } from "./AssistantFormFields";

const MODES: ReadonlyArray<{
  readonly mode: AutonomyMode;
  readonly icon: "bubble.left" | "bell.badge";
  readonly label: string;
}> = [
  { mode: "reply-only", icon: "bubble.left", label: "Only reply when I message it" },
  { mode: "reply-and-notify", icon: "bell.badge", label: "Reply and notify me" },
];

/** "Same as global" or a custom list: a list that is null inherits and any list overrides. */
function ScopeField<T extends string>(props: {
  readonly label: string;
  readonly description: string;
  readonly inheritLabel: string;
  readonly customLabel: string;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly value: ReadonlyArray<T> | null;
  /** The list a switch to custom starts from. */
  readonly seed: ReadonlyArray<T>;
  readonly onChange: (next: ReadonlyArray<T> | null) => void;
}) {
  const all = props.options.map((option) => option.value);
  const custom = props.value !== null;
  return (
    <View className="gap-2">
      <FieldHeader label={props.label} description={props.description} />
      <ListSection>
        <ChoiceRow
          role="radio"
          icon="globe"
          label={props.inheritLabel}
          selected={!custom}
          onPress={() => props.onChange(null)}
        />
        <ChoiceRow
          role="radio"
          icon="slider.horizontal.3"
          label={props.customLabel}
          selected={custom}
          onPress={() => (custom ? undefined : props.onChange(props.seed))}
        />
      </ListSection>
      {props.value === null ? null : (
        <ListSection>
          {props.options.map((option) => {
            const selected = props.value?.includes(option.value) ?? false;
            return (
              <ChoiceRow
                key={option.value}
                role="checkbox"
                label={option.label}
                selected={selected}
                onPress={() =>
                  props.onChange(toggleInList(all, props.value ?? [], option.value, !selected))
                }
              />
            );
          })}
        </ListSection>
      )}
    </View>
  );
}

/** The assistant's own wake-up settings; the saved value is the contract's `AssistantAutonomy`. */
export function AssistantNotificationsSection(props: {
  readonly value: AssistantAutonomy;
  readonly onChange: (next: AssistantAutonomy) => void;
  readonly globalAutonomy: AutonomySettings;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly label: string }>;
  readonly defaultProjectId: ProjectId | null;
}) {
  const { value, onChange } = props;
  const notify = value.mode === "reply-and-notify";
  const globalRules = AUTONOMY_RULE_OPTIONS.filter(
    (option) => props.globalAutonomy.rules[option.rule],
  ).map((option) => option.rule);
  return (
    <>
      <View className="gap-2">
        <FieldHeader
          label="Notifications"
          description="Whether it may wake on its own when something needs you."
        />
        <ListSection>
          {MODES.map((option) => (
            <ChoiceRow
              key={option.mode}
              role="radio"
              icon={option.icon}
              label={option.label}
              selected={value.mode === option.mode}
              onPress={() => onChange({ ...value, mode: option.mode })}
            />
          ))}
        </ListSection>
        {notify && !props.globalAutonomy.enabled ? (
          <Text textRole="footnote" className="px-2 text-warning-foreground">
            Notifications are paused for all assistants. Turn them on in Settings → Assistants →
            Autonomy.
          </Text>
        ) : null}
      </View>
      {notify ? (
        <>
          <ScopeField<AutonomyRule>
            label="When to notify"
            description="Which events may wake it."
            inheritLabel="Same as global"
            customLabel="Only for these"
            options={AUTONOMY_RULE_OPTIONS.map((o) => ({ value: o.rule, label: o.label }))}
            value={value.rules}
            seed={globalRules}
            onChange={(rules) => onChange({ ...value, rules })}
          />
          <ScopeField<ProjectId>
            label="Projects"
            description="Which projects it may wake for."
            inheritLabel="All projects"
            customLabel="Only these projects"
            options={props.projects.map((p) => ({ value: p.id, label: p.label }))}
            value={value.projectIds}
            seed={props.defaultProjectId ? [props.defaultProjectId] : []}
            onChange={(projectIds) => onChange({ ...value, projectIds })}
          />
          <ScopeField<AutonomyChannel>
            label="Channels"
            description="Where it tells you."
            inheritLabel="Same as global"
            customLabel="Only on these"
            options={(Object.keys(AUTONOMY_CHANNEL_LABELS) as AutonomyChannel[]).map((c) => ({
              value: c,
              label: AUTONOMY_CHANNEL_LABELS[c],
            }))}
            value={value.channels}
            seed={props.globalAutonomy.channels}
            onChange={(channels) => onChange({ ...value, channels })}
          />
        </>
      ) : null}
    </>
  );
}
