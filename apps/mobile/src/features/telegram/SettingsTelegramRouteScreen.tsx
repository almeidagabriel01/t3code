import {
  compactTelegramUserId,
  telegramDeliveryErrorReason,
  telegramSenderLabel,
  telegramStatusLabel,
  telegramSwitchHint,
  telegramUndeliveredLabel,
} from "@t3tools/client-runtime/state/telegramChannel";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState, type ComponentProps } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useTelegramChannel, useTelegramEnvironmentIds } from "../../state/telegramChannel";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { ChannelLanguageSection } from "../settings/components/ChannelLanguageSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { UndeliveredRepliesRow } from "../settings/components/UndeliveredRepliesRow";
import { CHANNEL_GOOD_TO_KNOW } from "../settings/components/channelCopy";
import { TELEGRAM_COPY } from "./telegramCopy";

function Hint(props: { readonly children: string; readonly tone?: "danger" }) {
  return (
    <Text
      textRole="footnote"
      selectable
      className={
        props.tone === "danger" ? "px-4 text-danger-foreground" : "px-4 text-foreground-muted"
      }
    >
      {props.children}
    </Text>
  );
}

function Field(props: {
  readonly label: string;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly secret?: boolean;
}) {
  return (
    <View className="gap-2 px-4 py-3">
      <View className="flex-row items-center gap-2">
        <SymbolView name={props.icon} size={16} tintColorClassName="accent-icon-muted" />
        <Text textRole="footnote" className="text-foreground-muted">
          {props.label}
        </Text>
      </View>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={props.secret === true}
        keyboardType={props.secret ? "default" : "number-pad"}
        editable={!props.disabled}
        className="rounded-lg border border-border px-3 py-2 text-foreground"
      />
    </View>
  );
}

/** A row with its own trailing text action, for items that are not navigation. */
function ItemRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly actionLabel: string;
  readonly disabled: boolean;
  readonly onAction: () => void;
}) {
  return (
    <ListRowLayout
      icon={props.icon}
      label={props.label}
      accessory={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.actionLabel}
          disabled={props.disabled}
          onPress={props.onAction}
          className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
        >
          <Text textRole="footnote" className="font-t3-medium text-foreground">
            Remove
          </Text>
        </Pressable>
      }
    />
  );
}

/** A person who wrote to the bot, with the two ways to answer: let them in or forget them. */
function PendingRow(props: {
  readonly name: string;
  readonly detail: string | undefined;
  readonly disabled: boolean;
  readonly onAllow: () => void;
  readonly onIgnore: () => void;
}) {
  return (
    <ListRowLayout
      icon="person.badge.clock"
      label={props.name}
      description={props.detail}
      accessory={
        <View className="flex-row items-center gap-2">
          {(
            [
              ["Allow", props.onAllow],
              ["Ignore", props.onIgnore],
            ] as const
          ).map(([action, onPress]) => (
            <Pressable
              key={action}
              accessibilityRole="button"
              accessibilityLabel={`${action} ${props.name}`}
              disabled={props.disabled}
              onPress={onPress}
              className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
            >
              <Text textRole="footnote" className="font-t3-medium text-foreground">
                {action}
              </Text>
            </Pressable>
          ))}
        </View>
      }
    />
  );
}

function TelegramEnvironment(props: {
  readonly environmentId: EnvironmentId;
  readonly title?: string;
}) {
  const telegram = useTelegramChannel(props.environmentId);
  const { settings } = telegram;
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [userId, setUserId] = useState("");
  if (settings === null) {
    return (
      <EmptyState
        variant="plain"
        title={telegram.loadError ? "Could not load Telegram" : "Loading Telegram"}
        detail={telegram.loadError ?? ""}
      />
    );
  }
  const disabled = !telegram.canConfigure;
  const hint = settings.enabled ? null : telegramSwitchHint(settings);
  const change = async (input: Parameters<typeof telegram.configure>[0]) => {
    const reply = await telegram.configure(input);
    setError(reply.ok ? null : reply.message);
    return reply.ok;
  };
  const saveToken = async () => {
    if (await change({ botToken: token.trim() })) setToken("");
  };
  const addUserId = async () => {
    const id = compactTelegramUserId(userId);
    if (settings.allowedUserIds.includes(id)) return setError("That is already added.");
    if (await change({ allowedUserIds: [...settings.allowedUserIds, id] })) setUserId("");
  };
  const failure = settings.lastDeliveryError;
  const suffix = props.title ? ` · ${props.title}` : "";
  return (
    <View className="gap-5">
      {error ? <Hint tone="danger">{error}</Hint> : null}
      <ListSection title={`${TELEGRAM_COPY.connection}${suffix}`}>
        <ListRowLayout
          icon="bolt.horizontal.circle"
          label={`${telegramStatusLabel(settings)}${
            settings.status === "running" && settings.botUsername
              ? ` as @${settings.botUsername}`
              : ""
          }`}
          description={
            failure
              ? `A reply was not delivered: ${telegramDeliveryErrorReason(failure)}.`
              : undefined
          }
        />
        <UndeliveredRepliesRow
          label={telegramUndeliveredLabel(settings)}
          disabled={!telegram.canResend}
          onResend={telegram.resendUndelivered}
          onError={setError}
        />
        <SettingsSwitchRow
          icon="paperplane"
          label={TELEGRAM_COPY.use}
          subtitle={hint ?? undefined}
          value={settings.enabled}
          disabled={disabled || hint !== null}
          onValueChange={(enabled) => void change({ enabled })}
        />
      </ListSection>
      <ChannelLanguageSection environmentId={props.environmentId} disabled={disabled} />
      <ListSection
        title={`${TELEGRAM_COPY.botToken}${suffix}`}
        footer={
          settings.tokenConfigured ? TELEGRAM_COPY.tokenFooterSaved : TELEGRAM_COPY.tokenFooterEmpty
        }
      >
        <ListRowLayout
          icon="key"
          label={settings.tokenConfigured ? TELEGRAM_COPY.tokenSaved : TELEGRAM_COPY.noToken}
        />
        <Field
          label={TELEGRAM_COPY.botToken}
          icon="key"
          placeholder={settings.tokenConfigured ? "New bot token" : "123456789:ABC…"}
          value={token}
          onChange={setToken}
          disabled={disabled}
          secret
        />
        <SettingsActionRow
          icon="checkmark.circle"
          label={settings.tokenConfigured ? "Replace token" : "Save token"}
          disabled={disabled || token.trim() === ""}
          onPress={() => void saveToken()}
        />
        {settings.tokenConfigured ? (
          <SettingsActionRow
            icon="trash"
            label="Remove token"
            disabled={disabled}
            onPress={() => void change({ clearToken: true })}
          />
        ) : null}
      </ListSection>
      {settings.pendingSenders && settings.pendingSenders.length > 0 ? (
        <ListSection
          title={`${TELEGRAM_COPY.waiting.title}${suffix}`}
          footer={TELEGRAM_COPY.waiting.footer}
        >
          {settings.pendingSenders.map((sender) => {
            const name = telegramSenderLabel(sender);
            return (
              <PendingRow
                key={sender.userId}
                name={name}
                detail={sender.firstName && sender.username ? `@${sender.username}` : undefined}
                disabled={disabled}
                onAllow={() =>
                  void change({ allowedUserIds: [...settings.allowedUserIds, sender.userId] })
                }
                onIgnore={() => void change({ dismissUserIds: [sender.userId] })}
              />
            );
          })}
        </ListSection>
      ) : null}
      <ListSection title={TELEGRAM_COPY.allowed.title} footer={TELEGRAM_COPY.allowed.footer}>
        {settings.allowedUserIds.map((id) => (
          <ItemRow
            key={id}
            icon="person.crop.circle"
            label={id}
            actionLabel={`Remove ${id}`}
            disabled={disabled}
            onAction={() =>
              void change({ allowedUserIds: settings.allowedUserIds.filter((item) => item !== id) })
            }
          />
        ))}
        <Field
          label={TELEGRAM_COPY.allowed.fieldLabel}
          icon="person.badge.plus"
          placeholder="123456789"
          value={userId}
          onChange={(value) => setUserId(compactTelegramUserId(value))}
          disabled={disabled}
        />
        <SettingsActionRow
          icon="plus"
          label="Add user id"
          disabled={disabled || userId.trim() === ""}
          onPress={() => void addUserId()}
        />
      </ListSection>
      <ListSection title={TELEGRAM_COPY.setUp.title}>
        <ListRowLayout
          icon="questionmark.bubble"
          label={TELEGRAM_COPY.setUp.create.title}
          description={TELEGRAM_COPY.setUp.create.description}
        />
        <ListRowLayout
          icon="bolt.circle"
          label={TELEGRAM_COPY.setUp.token.title}
          description={TELEGRAM_COPY.setUp.token.description}
        />
        <ListRowLayout
          icon="text.bubble"
          label={TELEGRAM_COPY.setUp.message.title}
          description={TELEGRAM_COPY.setUp.message.description}
        />
        <ListRowLayout
          icon="person.fill.checkmark"
          label={TELEGRAM_COPY.setUp.allow.title}
          description={TELEGRAM_COPY.setUp.allow.description}
        />
      </ListSection>
      <ListSection title={CHANNEL_GOOD_TO_KNOW.title}>
        <ListRowLayout
          icon="list.number"
          label={CHANNEL_GOOD_TO_KNOW.approvals.title}
          description={CHANNEL_GOOD_TO_KNOW.approvals.description}
        />
        <ListRowLayout
          icon="bubble.left.and.bubble.right"
          label={CHANNEL_GOOD_TO_KNOW.limits.title}
          description={CHANNEL_GOOD_TO_KNOW.limits.description}
        />
      </ListSection>
    </View>
  );
}

export function SettingsTelegramRouteScreen() {
  const environmentIds = useTelegramEnvironmentIds();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Telegram">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text textRole="footnote" className="px-4 text-foreground-muted">
          {TELEGRAM_COPY.intro}
        </Text>
        {environmentIds.length === 0 ? (
          <EmptyState
            variant="plain"
            title="Telegram is not available"
            detail="Connect an environment whose server supports Telegram."
          />
        ) : (
          environmentIds.map((environmentId) => (
            <TelegramEnvironment
              key={environmentId}
              environmentId={environmentId}
              title={
                environmentIds.length > 1
                  ? savedConnectionsById[environmentId]?.environmentLabel
                  : undefined
              }
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
