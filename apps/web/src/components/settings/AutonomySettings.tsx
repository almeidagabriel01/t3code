import {
  AUTONOMY_CHANNEL_LABELS,
  AUTONOMY_MINUTES_BOUNDS,
  AUTONOMY_RULE_OPTIONS,
  AUTONOMY_WAKES_BOUNDS,
  parseBoundedInt,
  withAutonomyChannel,
  withAutonomyRule,
} from "@t3tools/client-runtime/autonomy";
import type { AutonomySettings, EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { BellRingIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useTelegramEnvironmentIds, useTelegramSettings } from "../../state/telegramChannel";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const ICON = "size-4 text-muted-foreground";

/** Commits on blur or Enter once the text is a whole number inside the schema's bounds. */
function BoundedNumberField(props: {
  readonly label: string;
  readonly value: number;
  readonly bounds: { readonly min: number; readonly max: number };
  readonly unit: string;
  readonly onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(props.value));
  const parsed = parseBoundedInt(text, props.bounds);
  const commit = () => {
    if (parsed === null) return setText(String(props.value));
    if (parsed !== props.value) props.onCommit(parsed);
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label={props.label}
          className="w-24"
          inputMode="numeric"
          aria-invalid={parsed === null}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span className="text-xs text-muted-foreground">{props.unit}</span>
      </div>
      {parsed === null ? (
        <p className="text-xs text-destructive-foreground">
          Enter a whole number from {props.bounds.min} to {props.bounds.max}.
        </p>
      ) : null}
    </div>
  );
}

function TelegramNotice(props: { readonly environmentId: EnvironmentId }) {
  const { settings } = useTelegramSettings(props.environmentId);
  if (settings === undefined || settings === null || (settings.enabled && settings.tokenConfigured))
    return null;
  return (
    <SettingsRow
      title="Telegram is not set up"
      description={
        <>
          Notifications cannot reach Telegram until a bot is connected.{" "}
          <Link
            to="/settings/telegram"
            className="cursor-pointer rounded-sm underline outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            Open Telegram settings
          </Link>
        </>
      }
    />
  );
}

export function AutonomySection(props: {
  readonly environmentId: EnvironmentId;
  readonly suffix: string;
}) {
  const { environmentId } = props;
  const autonomy = useEnvironmentSettings(environmentId, (settings) => settings.autonomy);
  const update = useUpdateEnvironmentSettings(environmentId);
  const telegramIds = useTelegramEnvironmentIds();
  const write = (next: AutonomySettings) => update({ autonomy: next });

  return (
    <SettingsSection title={`Autonomy${props.suffix}`} icon={<BellRingIcon className={ICON} />}>
      <SettingsRow
        title="Assistants can notify you"
        description="Assistants set to notify wake on their own and tell you. Turn off to pause every rule and watch."
        control={
          <Switch
            checked={autonomy.enabled}
            aria-label="Assistants can notify you"
            onCheckedChange={(enabled) => write({ ...autonomy, enabled })}
          />
        }
      />
      {AUTONOMY_RULE_OPTIONS.map((option) => (
        <SettingsRow
          key={option.rule}
          title={option.label}
          description={option.description}
          control={
            <Switch
              checked={autonomy.rules[option.rule]}
              aria-label={option.label}
              onCheckedChange={(on) => write(withAutonomyRule(autonomy, option.rule, on))}
            />
          }
        />
      ))}
      <SettingsRow
        title="Waiting for you after"
        description="How long a run may wait on your answer before it counts as too long."
        control={
          <BoundedNumberField
            key={autonomy.waitingMinutes}
            label="Waiting minutes"
            value={autonomy.waitingMinutes}
            bounds={AUTONOMY_MINUTES_BOUNDS}
            unit="minutes"
            onCommit={(waitingMinutes) => write({ ...autonomy, waitingMinutes })}
          />
        }
      />
      <SettingsRow
        title="Stuck after"
        description="How long a run may show no activity before it looks stuck."
        control={
          <BoundedNumberField
            key={autonomy.stuckMinutes}
            label="Stuck minutes"
            value={autonomy.stuckMinutes}
            bounds={AUTONOMY_MINUTES_BOUNDS}
            unit="minutes"
            onCommit={(stuckMinutes) => write({ ...autonomy, stuckMinutes })}
          />
        }
      />
      <SettingsRow
        title="Notifications per day"
        description="Assistants stop waking after this many in a day."
        control={
          <BoundedNumberField
            key={autonomy.maxWakesPerDay}
            label="Notifications per day"
            value={autonomy.maxWakesPerDay}
            bounds={AUTONOMY_WAKES_BOUNDS}
            unit="per day"
            onCommit={(maxWakesPerDay) => write({ ...autonomy, maxWakesPerDay })}
          />
        }
      />
      {(["telegram", "t3"] as const).map((channel) => (
        <SettingsRow
          key={channel}
          title={`Notify on ${AUTONOMY_CHANNEL_LABELS[channel]}`}
          description={
            channel === "telegram"
              ? "Send the answer to the first allowed Telegram user."
              : "Show the answer in Activity, on every device."
          }
          control={
            <Switch
              checked={autonomy.channels.includes(channel)}
              aria-label={`Notify on ${AUTONOMY_CHANNEL_LABELS[channel]}`}
              onCheckedChange={(on) => write(withAutonomyChannel(autonomy, channel, on))}
            />
          }
        />
      ))}
      {autonomy.channels.includes("telegram") ? (
        telegramIds.includes(environmentId) ? (
          <TelegramNotice environmentId={environmentId} />
        ) : (
          <SettingsRow
            title="Telegram is not available"
            description="This server does not support Telegram."
          />
        )
      ) : null}
    </SettingsSection>
  );
}
