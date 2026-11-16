import { useNavigation } from "@react-navigation/native";
import {
  AUTONOMY_CHANNEL_LABELS,
  AUTONOMY_MINUTES_BOUNDS,
  AUTONOMY_NOTIFY_AFTER_BOUNDS,
  AUTONOMY_RULE_OPTIONS,
  AUTONOMY_USER_MESSAGES_BOUNDS,
  AUTONOMY_WAKES_BOUNDS,
  DETECT_PROBLEMS_DESCRIPTION,
  DETECT_PROBLEMS_LABEL,
  parseBoundedInt,
  withAutonomyChannel,
  withAutonomyRule,
} from "@t3tools/client-runtime/autonomy";
import type { AutonomyChannel, AutonomyRule, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useAutonomySettings } from "../../state/autonomy";
import { AUTONOMY_COPY } from "./settingsAssistantsCopy";
import { useTelegramChannel, useTelegramEnvironmentIds } from "../../state/telegramChannel";

const RULE_ICONS: Record<AutonomyRule, AppSymbolName> = {
  runFailed: "exclamationmark.triangle",
  waitingTooLong: "person.badge.clock",
  stuck: "hourglass",
  ciFailed: PullRequestGlyph.pullRequest,
  reviewIncomplete: "checklist.unchecked",
};

const CHANNEL_ROWS: ReadonlyArray<{
  readonly channel: AutonomyChannel;
  readonly icon: AppSymbolName;
  readonly description: string;
}> = [
  {
    channel: "telegram",
    icon: "paperplane",
    description: AUTONOMY_COPY.channelDescription.telegram,
  },
  { channel: "t3", icon: "iphone", description: AUTONOMY_COPY.channelDescription.t3 },
];

/** Commits when editing ends on a whole number inside the schema's bounds; otherwise reverts. */
function BoundedNumberRow(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly description: string;
  readonly unit: string;
  readonly value: number;
  readonly bounds: { readonly min: number; readonly max: number };
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
    <View className="bg-grouped-card">
      <ListRowLayout
        icon={props.icon}
        label={props.label}
        description={props.description}
        accessory={
          <View className="flex-row items-center gap-2">
            <TextInput
              accessibilityLabel={props.label}
              accessibilityHint={props.unit}
              value={text}
              onChangeText={setText}
              onEndEditing={commit}
              keyboardType="number-pad"
              autoCapitalize="none"
              autoCorrect={false}
              selectTextOnFocus
              editable={!props.disabled}
              accessibilityState={{ disabled: props.disabled }}
              className={`min-h-8 w-16 rounded-lg bg-subtle px-2 text-right font-sans text-base text-foreground ${props.disabled ? "opacity-50" : ""}`}
            />
            <Text textRole="footnote" className="text-foreground-muted">
              {props.unit}
            </Text>
          </View>
        }
      />
      {parsed === null ? (
        <Text
          accessibilityRole="alert"
          textRole="footnote"
          className="px-4 pb-3 text-danger-foreground"
        >
          Enter a whole number from {props.bounds.min} to {props.bounds.max}.
        </Text>
      ) : null}
    </View>
  );
}

function TelegramNotice(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const { settings } = useTelegramChannel(props.environmentId);
  if (!settings || (settings.enabled && settings.tokenConfigured)) return null;
  return (
    <ListRow
      icon="exclamationmark.circle"
      label={AUTONOMY_COPY.telegramNotSetUp.title}
      description={AUTONOMY_COPY.telegramNotSetUp.description}
      onPress={() => navigation.navigate("SettingsTelegram")}
    />
  );
}

/** Settings → Assistants → Autonomy: the global rules, thresholds and channels for one server. */
export function AutonomySettingsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly suffix: string;
}) {
  const { environmentId } = props;
  const { autonomy, write, detectProblems, writeDetectProblems } =
    useAutonomySettings(environmentId);
  const telegramAvailable = useTelegramEnvironmentIds().includes(environmentId);
  const paused = !autonomy.enabled;
  return (
    <ListSection title={`${AUTONOMY_COPY.title}${props.suffix}`} footer={AUTONOMY_COPY.footer}>
      <ListToggleRow
        icon="bell.badge"
        label={AUTONOMY_COPY.notifyEnabled.title}
        description={AUTONOMY_COPY.notifyEnabled.description}
        value={autonomy.enabled}
        onValueChange={(enabled) => void write({ ...autonomy, enabled })}
      />
      <ListToggleRow
        icon="exclamationmark.shield"
        label={DETECT_PROBLEMS_LABEL}
        description={DETECT_PROBLEMS_DESCRIPTION}
        value={detectProblems}
        onValueChange={(on) => void writeDetectProblems(on)}
      />
      <ListToggleRow
        icon="envelope.badge"
        label={AUTONOMY_COPY.notifyWaiting.title}
        description={AUTONOMY_COPY.notifyWaiting.description}
        value={autonomy.notifyWaiting}
        disabled={paused}
        onValueChange={(notifyWaiting) => void write({ ...autonomy, notifyWaiting })}
      />
      <BoundedNumberRow
        key={`notifyAfter:${autonomy.notifyWaitingAfterMinutes}`}
        icon="calendar.badge.clock"
        label={AUTONOMY_COPY.notifyAfter.title}
        description={AUTONOMY_COPY.notifyAfter.description}
        unit="minutes"
        value={autonomy.notifyWaitingAfterMinutes}
        bounds={AUTONOMY_NOTIFY_AFTER_BOUNDS}
        disabled={paused || !autonomy.notifyWaiting}
        onCommit={(notifyWaitingAfterMinutes) =>
          void write({ ...autonomy, notifyWaitingAfterMinutes })
        }
      />
      {AUTONOMY_RULE_OPTIONS.map((option) => (
        <ListToggleRow
          key={option.rule}
          icon={RULE_ICONS[option.rule]}
          label={option.label}
          description={option.description}
          value={autonomy.rules[option.rule]}
          disabled={paused}
          onValueChange={(on) => void write(withAutonomyRule(autonomy, option.rule, on))}
        />
      ))}
      <BoundedNumberRow
        key={`waiting:${autonomy.waitingMinutes}`}
        icon="clock"
        label={AUTONOMY_COPY.waitingAfter.title}
        description={AUTONOMY_COPY.waitingAfter.description}
        unit="minutes"
        value={autonomy.waitingMinutes}
        bounds={AUTONOMY_MINUTES_BOUNDS}
        disabled={paused}
        onCommit={(waitingMinutes) => void write({ ...autonomy, waitingMinutes })}
      />
      <BoundedNumberRow
        key={`stuck:${autonomy.stuckMinutes}`}
        icon="timer"
        label={AUTONOMY_COPY.stuckAfter.title}
        description={AUTONOMY_COPY.stuckAfter.description}
        unit="minutes"
        value={autonomy.stuckMinutes}
        bounds={AUTONOMY_MINUTES_BOUNDS}
        disabled={paused}
        onCommit={(stuckMinutes) => void write({ ...autonomy, stuckMinutes })}
      />
      <BoundedNumberRow
        key={`wakes:${autonomy.maxWakesPerDay}`}
        icon="calendar"
        label={AUTONOMY_COPY.wakesPerDay.title}
        description={AUTONOMY_COPY.wakesPerDay.description}
        unit="per day"
        value={autonomy.maxWakesPerDay}
        bounds={AUTONOMY_WAKES_BOUNDS}
        disabled={paused}
        onCommit={(maxWakesPerDay) => void write({ ...autonomy, maxWakesPerDay })}
      />
      <BoundedNumberRow
        key={`userMessages:${autonomy.maxUserMessagesPerDay}`}
        icon="bubble.left"
        label={AUTONOMY_COPY.messagesPerDay.title}
        description={AUTONOMY_COPY.messagesPerDay.description}
        unit="per day"
        value={autonomy.maxUserMessagesPerDay}
        bounds={AUTONOMY_USER_MESSAGES_BOUNDS}
        disabled={paused}
        onCommit={(maxUserMessagesPerDay) => void write({ ...autonomy, maxUserMessagesPerDay })}
      />
      {CHANNEL_ROWS.map((row) => (
        <ListToggleRow
          key={row.channel}
          icon={row.icon}
          label={`Notify on ${AUTONOMY_CHANNEL_LABELS[row.channel]}`}
          description={row.description}
          value={autonomy.channels.includes(row.channel)}
          disabled={paused}
          onValueChange={(on) => void write(withAutonomyChannel(autonomy, row.channel, on))}
        />
      ))}
      {autonomy.channels.includes("telegram") ? (
        telegramAvailable ? (
          <TelegramNotice environmentId={environmentId} />
        ) : (
          <View className="bg-grouped-card">
            <ListRowLayout
              icon="exclamationmark.circle"
              label={AUTONOMY_COPY.telegramUnavailable.title}
              description={AUTONOMY_COPY.telegramUnavailable.description}
            />
          </View>
        )
      ) : null}
    </ListSection>
  );
}
