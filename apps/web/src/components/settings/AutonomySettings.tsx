import {
  AUTONOMY_CHANNEL_LABELS,
  AUTONOMY_MINUTES_BOUNDS,
  AUTONOMY_NOTIFY_AFTER_BOUNDS,
  AUTONOMY_RULE_OPTIONS,
  AUTONOMY_USER_MESSAGES_BOUNDS,
  AUTONOMY_WAKES_BOUNDS,
  DETECT_PROBLEMS_LABEL,
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
import { settingCopy } from "./settingsSearch";

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
      // oxlint-disable-next-line t3code/require-searchable-settings-copy -- notice, not a setting
      title="Telegram is not set up"
      // oxlint-disable-next-line t3code/require-searchable-settings-copy -- notice, not a setting
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
  const detectProblems = useEnvironmentSettings(
    environmentId,
    (settings) => settings.detectProblems,
  );
  const update = useUpdateEnvironmentSettings(environmentId);
  const telegramIds = useTelegramEnvironmentIds();
  const write = (next: AutonomySettings) => update({ autonomy: next });
  const paused = !autonomy.enabled;

  return (
    <SettingsSection
      title={`${settingCopy("autonomy").title}${props.suffix}`}
      icon={<BellRingIcon className={ICON} />}
    >
      <SettingsRow
        {...settingCopy("autonomy-notify")}
        control={
          <Switch
            checked={autonomy.enabled}
            aria-label="Assistants can notify you"
            onCheckedChange={(enabled) => write({ ...autonomy, enabled })}
          />
        }
      />
      <SettingsRow
        {...settingCopy("autonomy-detect-problems")}
        control={
          <Switch
            checked={detectProblems}
            aria-label={DETECT_PROBLEMS_LABEL}
            onCheckedChange={(on) => update({ detectProblems: on })}
          />
        }
      />
      <SettingsRow
        {...settingCopy("autonomy-notify-waiting")}
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
        {...settingCopy("autonomy-notify-after")}
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
        {...settingCopy("autonomy-waiting-after")}
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
        {...settingCopy("autonomy-stuck-after")}
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
        {...settingCopy("autonomy-wakes-per-day")}
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
        {...settingCopy("autonomy-messages-per-day")}
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
          {...settingCopy(`autonomy-notify-${channel}`)}
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
            // oxlint-disable-next-line t3code/require-searchable-settings-copy -- unavailable state, not a setting
            title="Telegram is not available"
            // oxlint-disable-next-line t3code/require-searchable-settings-copy -- unavailable state, not a setting
            description="This server does not support Telegram."
          />
        )
      ) : null}
    </SettingsSection>
  );
}
