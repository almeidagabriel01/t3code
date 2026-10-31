import type { EnvironmentId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useState, type ComponentProps } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { confirm } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useSlackChannel, useSlackEnvironmentIds } from "../../state/slackChannel";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  SLACK_LINK_INSTRUCTION,
  SLACK_MANIFEST,
  parseSlackChannelId,
  slackDeliveryNote,
  slackStatusLabel,
} from "./slackPresentation";

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
  readonly secure?: boolean;
  readonly disabled: boolean;
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
        secureTextEntry={props.secure}
        autoCapitalize="none"
        autoCorrect={false}
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
  readonly description?: string;
  readonly action: string;
  readonly actionLabel: string;
  readonly disabled: boolean;
  readonly onAction: () => void;
}) {
  return (
    <ListRowLayout
      icon={props.icon}
      label={props.label}
      description={props.description}
      accessory={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.actionLabel}
          disabled={props.disabled}
          onPress={props.onAction}
          className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
        >
          <Text textRole="footnote" className="font-t3-medium text-foreground">
            {props.action}
          </Text>
        </Pressable>
      }
    />
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function SlackEnvironment(props: {
  readonly environmentId: EnvironmentId;
  readonly title?: string;
}) {
  const slack = useSlackChannel(props.environmentId);
  const { settings } = slack;
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [channelDraft, setChannelDraft] = useState("");
  const [message, setMessage] = useState<{
    readonly text: string;
    readonly danger: boolean;
  } | null>(null);
  const [linkCode, setLinkCode] = useState<{
    readonly code: string;
    readonly expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  if (settings === null) {
    return (
      <EmptyState
        variant="plain"
        title={slack.loadError ? "Could not load Slack" : "Loading Slack"}
        detail={slack.loadError ?? ""}
      />
    );
  }
  const tokensSaved = settings.hasAppToken && settings.hasBotToken;
  const showFields = !tokensSaved || replacing;
  const typedAny = appToken.trim() !== "" || botToken.trim() !== "";
  const note = slackDeliveryNote(settings);
  const report = (reply: { readonly ok: boolean; readonly message?: string }) => {
    setMessage(reply.ok ? null : { text: reply.message ?? "", danger: true });
    return reply.ok;
  };
  const saveTokens = async () => {
    const reply = await slack.configure({
      ...(appToken.trim() ? { appToken: appToken.trim() } : {}),
      ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
    });
    if (!reply.ok) {
      setMessage({
        text: reply.invalidToken ? "Slack rejected this token." : reply.message,
        danger: true,
      });
      return;
    }
    setMessage(null);
    setAppToken("");
    setBotToken("");
    setReplacing(false);
  };
  const removeTokens = () =>
    confirm({
      title: "Remove Slack tokens?",
      message: "Slack disconnects and both tokens are deleted. You can save new ones later.",
      confirmText: "Remove tokens",
      destructive: true,
      onConfirm: () => void slack.disconnect().then(report),
    });
  const channelIds = settings.allowedChannelIds;
  const addChannel = async () => {
    const parsed = parseSlackChannelId(channelDraft, channelIds);
    if ("error" in parsed) {
      setMessage({ text: parsed.error, danger: true });
      return;
    }
    if (report(await slack.configure({ allowedChannelIds: [...channelIds, parsed.id] }))) {
      setChannelDraft("");
    }
  };
  const copy = async (key: string, text: string) => {
    await Clipboard.setStringAsync(text);
    setCopied(key);
  };
  const makeLinkCode = async () => {
    const reply = await slack.createLinkCode(settings.connectionId);
    if (reply.ok) setLinkCode(reply.value);
    report(reply);
  };
  return (
    <View className="gap-5">
      {message ? <Hint tone={message.danger ? "danger" : undefined}>{message.text}</Hint> : null}
      <ListSection title={props.title ? `Connection · ${props.title}` : "Connection"}>
        <ListRowLayout
          icon="bolt.horizontal.circle"
          label={slackStatusLabel(settings)}
          description={note ?? undefined}
        />
        <SettingsSwitchRow
          icon="text.bubble"
          label="Use Slack"
          subtitle={tokensSaved ? undefined : "Save both tokens first."}
          value={settings.enabled}
          disabled={!slack.canConfigure || !tokensSaved}
          onValueChange={(enabled) => void slack.configure({ enabled }).then(report)}
        />
      </ListSection>
      <ListSection
        title="Tokens"
        footer="Tokens are write-only: Slack keeps them on the server and never shows them again."
      >
        {tokensSaved && !replacing ? (
          <>
            <ListRowLayout icon="cable.connector" label="App token" description="Saved" />
            <ListRowLayout icon="person.crop.circle" label="Bot token" description="Saved" />
            <SettingsActionRow
              icon="arrow.clockwise"
              label="Replace tokens"
              disabled={!slack.canConfigure}
              onPress={() => setReplacing(true)}
            />
          </>
        ) : null}
        {showFields ? (
          <>
            <Field
              label="App token"
              icon="cable.connector"
              placeholder={settings.hasAppToken ? "Saved, type to replace" : "xapp-…"}
              value={appToken}
              onChange={setAppToken}
              secure
              disabled={!slack.canConfigure}
            />
            <Field
              label="Bot token"
              icon="person.crop.circle"
              placeholder={settings.hasBotToken ? "Saved, type to replace" : "xoxb-…"}
              value={botToken}
              onChange={setBotToken}
              secure
              disabled={!slack.canConfigure}
            />
            <SettingsActionRow
              icon="checkmark.circle"
              label="Save tokens"
              disabled={!slack.canConfigure || !typedAny}
              onPress={() => void saveTokens()}
            />
          </>
        ) : null}
        {settings.hasAppToken || settings.hasBotToken ? (
          <SettingsActionRow
            icon="trash"
            tone="danger"
            label="Remove tokens"
            disabled={!slack.canDisconnect}
            onPress={removeTokens}
          />
        ) : null}
      </ListSection>
      <ListSection
        title="Channels"
        footer="The bot answers @mentions in these channels. Direct messages always work."
      >
        {channelIds.map((id) => (
          <ItemRow
            key={id}
            icon="bubble.left"
            label={id}
            action="Remove"
            actionLabel={`Remove ${id}`}
            disabled={!slack.canConfigure}
            onAction={() =>
              void slack
                .configure({ allowedChannelIds: channelIds.filter((entry) => entry !== id) })
                .then(report)
            }
          />
        ))}
        <Field
          label="Channel ID"
          icon="plus"
          placeholder="C0123456789"
          value={channelDraft}
          onChange={setChannelDraft}
          disabled={!slack.canConfigure}
        />
        <SettingsActionRow
          icon="plus.bubble"
          label="Add channel"
          disabled={!slack.canConfigure || channelDraft.trim() === ""}
          onPress={() => void addChannel()}
        />
      </ListSection>
      <ListSection
        title="Linked accounts"
        footer="Link your Slack account so messages you send count as you."
      >
        {slack.identities.length === 0 ? (
          <ListRowLayout icon="person.fill.xmark" label="No linked accounts" />
        ) : (
          slack.identities.map((identity) => (
            <ItemRow
              key={identity.externalActorId}
              icon="person.fill.checkmark"
              label={identity.displayName ?? `Slack user ${identity.externalActorId}`}
              description={`Linked ${formatTime(identity.linkedAt)}`}
              action="Unlink"
              actionLabel={`Unlink ${identity.externalActorId}`}
              disabled={!slack.canUnlink}
              onAction={() =>
                void slack.unlink(settings.connectionId, identity.externalActorId).then(report)
              }
            />
          ))
        )}
        <SettingsActionRow
          icon="link"
          label="Link your Slack account"
          disabled={!slack.canLink || !tokensSaved}
          onPress={() => void makeLinkCode()}
        />
        {linkCode ? (
          <View className="gap-1 px-4 py-3">
            <Text selectable accessibilityLabel="Link code" className="text-3xl font-t3-medium">
              {linkCode.code}
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {`Expires ${formatTime(linkCode.expiresAt)}`}
            </Text>
            <Text textRole="footnote" selectable className="text-foreground-muted">
              {SLACK_LINK_INSTRUCTION(linkCode.code)}
            </Text>
          </View>
        ) : null}
        {linkCode ? (
          <SettingsActionRow
            icon="doc.on.doc"
            label={copied === "code" ? "Copied" : "Copy link command"}
            onPress={() => void copy("code", `link ${linkCode.code}`)}
          />
        ) : null}
      </ListSection>
      <ListSection title="Create the Slack app">
        <ListRowLayout
          icon="list.number"
          label="1. Create from manifest"
          description="At api.slack.com/apps choose Create New App, From a manifest, and paste the manifest."
        />
        <ListRowLayout
          icon="cable.connector"
          label="2. App token"
          description="Basic Information, App-Level Tokens: generate one with the connections:write scope."
        />
        <ListRowLayout
          icon="person.crop.circle"
          label="3. Bot token"
          description="Install the app to your workspace and copy the Bot User OAuth Token."
        />
        <SettingsActionRow
          icon="doc.text"
          label={copied === "manifest" ? "Copied" : "Copy manifest"}
          onPress={() => void copy("manifest", SLACK_MANIFEST)}
        />
      </ListSection>
    </View>
  );
}

export function SettingsSlackRouteScreen() {
  const environmentIds = useSlackEnvironmentIds();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Slack">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text textRole="footnote" className="px-4 text-foreground-muted">
          Talk to your assistants from Slack. Message the bot directly or @mention it in a channel.
          Start with @Name to talk to a specific assistant; Jarvis answers otherwise, and the
          conversation stays with the last assistant you picked.
        </Text>
        {environmentIds.length === 0 ? (
          <EmptyState
            variant="plain"
            title="Slack is not available"
            detail="Connect an environment whose server supports Slack."
          />
        ) : (
          environmentIds.map((environmentId) => (
            <SlackEnvironment
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
