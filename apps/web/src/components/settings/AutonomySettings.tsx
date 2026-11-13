import {
  AUTONOMY_CHANNEL_LABELS,
  AUTONOMY_MINUTES_BOUNDS,
  AUTONOMY_NOTIFY_AFTER_BOUNDS,
  AUTONOMY_RULE_OPTIONS,
  AUTONOMY_USER_MESSAGES_BOUNDS,
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
  readonly disabled: boolean;
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
          disabled={props.disabled}
          aria-invalid={parsed === null}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span className="w-12 text-xs text-muted-foreground">{props.unit}</span>
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
  const paused = !autonomy.enabled;

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
      <SettingsRow
        title="Notify me when something is waiting for me"
        description="Approvals, questions, open decisions and paused group tasks reach you directly, with no model and no daily limit. Works for every assistant and thread."
        control={
          <Switch
            checked={autonomy.notifyWaiting}
            aria-label="Notify me when something is waiting for me"
            disabled={paused}
            onCheckedChange={(notifyWaiting) => write({ ...autonomy, notifyWaiting })}
          />
        }
      />
      <SettingsRow
        title="Notify after"
        description="Something answered sooner is not sent."
        control={
          <BoundedNumberField
            key={autonomy.notifyWaitingAfterMinutes}
            label="Notify after"
            value={autonomy.notifyWaitingAfterMinutes}
            bounds={AUTONOMY_NOTIFY_AFTER_BOUNDS}
            unit="minutes"
            disabled={paused || !autonomy.notifyWaiting}
            onCommit={(notifyWaitingAfterMinutes) =>
              write({ ...autonomy, notifyWaitingAfterMinutes })
            }
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
              disabled={paused}
              onCheckedChange={(on) => write(withAutonomyRule(autonomy, option.rule, on))}
            />
          }
        />
      ))}
      <SettingsRow
        title="Waiting for you after"
        description="How long a run may wait on your answer before an assistant wakes to look into it."
        control={
          <BoundedNumberField
            key={autonomy.waitingMinutes}
            label="Waiting minutes"
            value={autonomy.waitingMinutes}
            bounds={AUTONOMY_MINUTES_BOUNDS}
            unit="minutes"
            disabled={paused}
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
            disabled={paused}
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
            disabled={paused}
            onCommit={(maxWakesPerDay) => write({ ...autonomy, maxWakesPerDay })}
          />
        }
      />
      <SettingsRow
        title="Messages from assistants per day"
        description="How many short messages each assistant can send you on its own."
        control={
          <BoundedNumberField
            key={autonomy.maxUserMessagesPerDay}
            label="Messages from assistants per day"
            value={autonomy.maxUserMessagesPerDay}
            bounds={AUTONOMY_USER_MESSAGES_BOUNDS}
            unit="per day"
            disabled={paused}
            onCommit={(maxUserMessagesPerDay) => write({ ...autonomy, maxUserMessagesPerDay })}
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
              disabled={paused}
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
