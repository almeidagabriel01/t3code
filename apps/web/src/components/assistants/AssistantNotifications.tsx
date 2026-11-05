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

import { Checkbox } from "../ui/checkbox";
import { Radio, RadioGroup } from "../ui/radio-group";

const ROW =
  "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-sm outline-hidden hover:bg-foreground/8";

/** "Same as global" or a custom list, so a list that is null inherits and any list overrides. */
function ScopeField<T extends string>(props: {
  readonly legend: string;
  readonly inheritLabel: string;
  readonly customLabel: string;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly value: ReadonlyArray<T> | null;
  /** The list a switch to custom starts from. */
  readonly seed: ReadonlyArray<T>;
  readonly onChange: (next: ReadonlyArray<T> | null) => void;
}) {
  const all = props.options.map((option) => option.value);
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium">{props.legend}</legend>
      <RadioGroup
        aria-label={props.legend}
        value={props.value === null ? "inherit" : "custom"}
        onValueChange={(next) => props.onChange(next === "inherit" ? null : props.seed)}
      >
        <label className={ROW}>
          <Radio value="inherit" />
          {props.inheritLabel}
        </label>
        <label className={ROW}>
          <Radio value="custom" />
          {props.customLabel}
        </label>
      </RadioGroup>
      {props.value === null ? null : (
        <div className="ms-6 flex flex-col">
          {props.options.map((option) => (
            <label key={option.value} className={ROW}>
              <Checkbox
                checked={props.value?.includes(option.value) ?? false}
                aria-label={option.label}
                onCheckedChange={(on) =>
                  props.onChange(toggleInList(all, props.value ?? [], option.value, Boolean(on)))
                }
              />
              {option.label}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** The assistant's own wake-up settings; the saved value is the contract's `AssistantAutonomy`. */
export function AssistantNotifications(props: {
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
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium">Notifications</legend>
        <p className="text-xs text-muted-foreground">
          Whether it may wake on its own when something needs you.
        </p>
        <RadioGroup
          aria-label="Notifications"
          value={value.mode}
          onValueChange={(mode) => onChange({ ...value, mode: mode as AutonomyMode })}
        >
          {(
            [
              ["reply-only", "Only reply when I message it"],
              ["reply-and-notify", "Reply and notify me"],
            ] as const
          ).map(([mode, label]) => (
            <label key={mode} className={ROW}>
              <Radio value={mode} />
              {label}
            </label>
          ))}
        </RadioGroup>
        {notify && !props.globalAutonomy.enabled ? (
          <p className="text-xs text-muted-foreground">
            Notifications are paused for all assistants. Turn them on in Settings → Assistants →
            Autonomy.
          </p>
        ) : null}
      </fieldset>
      {notify ? (
        <>
          <ScopeField<AutonomyRule>
            legend="When to notify"
            inheritLabel="Same as global"
            customLabel="Only for these"
            options={AUTONOMY_RULE_OPTIONS.map((o) => ({ value: o.rule, label: o.label }))}
            value={value.rules}
            seed={globalRules}
            onChange={(rules) => onChange({ ...value, rules })}
          />
          <ScopeField<ProjectId>
            legend="Projects"
            inheritLabel="All projects"
            customLabel="Only these projects"
            options={props.projects.map((p) => ({ value: p.id, label: p.label }))}
            value={value.projectIds}
            seed={props.defaultProjectId ? [props.defaultProjectId] : []}
            onChange={(projectIds) => onChange({ ...value, projectIds })}
          />
          <ScopeField<AutonomyChannel>
            legend="Channels"
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
    </div>
  );
}
