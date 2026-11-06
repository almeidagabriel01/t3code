import {
  formatImessageHandleInput,
  imessageDefaultCallingCode,
  imessageSuggestedSelfHandles,
} from "@t3tools/client-runtime/state/imessageChannel";
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
import { useImessageChannel, useImessageEnvironmentIds } from "../../state/imessageChannel";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { ChannelLanguageSection } from "../settings/components/ChannelLanguageSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  imessageAccessRow,
  imessageDeliveryNote,
  imessageEnableBlocker,
  imessageStatusLabel,
  parseImessageHandle,
} from "./imessagePresentation";

const CALLING_CODE = imessageDefaultCallingCode([Intl.DateTimeFormat().resolvedOptions().locale]);

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
        keyboardType="email-address"
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

function HandleSection(props: {
  readonly title: string;
  readonly footer: string;
  readonly fieldLabel: string;
  readonly addLabel: string;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly handles: ReadonlyArray<string>;
  /** Handles found on the Mac that one tap adds. */
  readonly suggestions?: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (handles: ReadonlyArray<string>) => Promise<boolean>;
  readonly onError: (text: string) => void;
}) {
  const suggestions = props.suggestions ?? [];
  const [draft, setDraft] = useState("");
  const add = async () => {
    const parsed = parseImessageHandle(draft, props.handles);
    if ("error" in parsed) {
      props.onError(parsed.error);
      return;
    }
    if (await props.onChange([...props.handles, parsed.handle])) setDraft("");
  };
  return (
    <ListSection title={props.title} footer={props.footer}>
      {suggestions.length > 0 ? (
        <SettingsActionRow
          icon="laptopcomputer"
          label="Add the ones found on this Mac"
          description={suggestions.map((handle) => formatImessageHandleInput(handle)).join(", ")}
          disabled={props.disabled}
          onPress={() => void props.onChange([...props.handles, ...suggestions])}
        />
      ) : null}
      {props.handles.map((handle) => (
        <ItemRow
          key={handle}
          icon={props.icon}
          label={formatImessageHandleInput(handle)}
          actionLabel={`Remove ${handle}`}
          disabled={props.disabled}
          onAction={() => void props.onChange(props.handles.filter((entry) => entry !== handle))}
        />
      ))}
      <Field
        label={props.fieldLabel}
        icon="plus"
        placeholder="Phone number or email"
        value={draft}
        onChange={(value) => setDraft(formatImessageHandleInput(value, CALLING_CODE))}
        disabled={props.disabled}
      />
      <SettingsActionRow
        icon="plus.bubble"
        label={props.addLabel}
        disabled={props.disabled || draft.trim() === ""}
        onPress={() => void add()}
      />
    </ListSection>
  );
}

function ImessageEnvironment(props: {
  readonly environmentId: EnvironmentId;
  readonly title?: string;
}) {
  const imessage = useImessageChannel(props.environmentId);
  const { settings } = imessage;
  const [error, setError] = useState<string | null>(null);
  if (settings === null) {
    return (
      <EmptyState
        variant="plain"
        title={imessage.loadError ? "Could not load iMessage" : "Loading iMessage"}
        detail={imessage.loadError ?? ""}
      />
    );
  }
  const access = imessageAccessRow(imessage.access);
  const note = imessageDeliveryNote(settings);
  const blocker = settings.enabled ? null : imessageEnableBlocker(imessage.access, settings);
  const change = async (input: Parameters<typeof imessage.configure>[0]) => {
    const reply = await imessage.configure(input);
    setError(reply.ok ? null : reply.message);
    return reply.ok;
  };
  const suffix = props.title ? ` · ${props.title}` : "";
  return (
    <View className="gap-5">
      {error ? <Hint tone="danger">{error}</Hint> : null}
      <ListSection title={`Access${suffix}`}>
        <ListRowLayout
          icon="eye"
          label={`Full Disk Access: ${access.label}`}
          description={access.description}
        />
        <SettingsActionRow
          icon="arrow.clockwise"
          label="Check again"
          onPress={() => imessage.checkAccess()}
        />
      </ListSection>
      <ListSection title={`Connection${suffix}`}>
        <ListRowLayout
          icon="bolt.horizontal.circle"
          label={imessageStatusLabel(settings)}
          description={note ?? undefined}
        />
        <SettingsSwitchRow
          icon="text.bubble"
          label="Use iMessage"
          subtitle={blocker ?? undefined}
          value={settings.enabled}
          disabled={!imessage.canConfigure || blocker !== null}
          onValueChange={(enabled) => void change({ enabled })}
        />
      </ListSection>
      <ChannelLanguageSection
        environmentId={props.environmentId}
        disabled={!imessage.canConfigure}
      />
      <HandleSection
        title="Chat with yourself"
        footer="Your own numbers and emails. The assistant answers in the same chat, and each reply starts with its name."
        fieldLabel="Your number or email"
        addLabel="Add yours"
        icon="person.crop.circle"
        handles={settings.selfHandles}
        suggestions={imessageSuggestedSelfHandles(imessage.ownHandles, settings)}
        disabled={!imessage.canConfigure}
        onChange={(selfHandles) => change({ selfHandles })}
        onError={setError}
      />
      <HandleSection
        title="Other accounts"
        footer="Numbers and emails allowed to message the assistants, for when Messages on the Mac uses its own Apple ID."
        fieldLabel="Allowed number or email"
        addLabel="Add account"
        icon="person.2"
        handles={settings.allowedHandles}
        disabled={!imessage.canConfigure}
        onChange={(allowedHandles) => change({ allowedHandles })}
        onError={setError}
      />
      <ListSection title="Good to know">
        <ListRowLayout
          icon="list.number"
          label="Approvals"
          description="Approvals arrive as numbered choices. Reply with the number."
        />
        <ListRowLayout
          icon="bubble.left.and.bubble.right"
          label="Limits"
          description="Group chats and attachments are not supported, and more than 10 messages a minute from one person are held back."
        />
      </ListSection>
    </View>
  );
}

export function SettingsImessageRouteScreen() {
  const environmentIds = useImessageEnvironmentIds();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="iMessage">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text textRole="footnote" className="px-4 text-foreground-muted">
          Talk to your assistants from Messages on the Mac running T3 Code. Start with @Name to pick
          an assistant; Jarvis answers otherwise, and the chat stays with the last one picked. Send
          @ on its own to list them. It works while T3 Code is running on that Mac.
        </Text>
        {environmentIds.length === 0 ? (
          <EmptyState
            variant="plain"
            title="iMessage is not available"
            detail="Connect an environment whose server runs on a Mac."
          />
        ) : (
          environmentIds.map((environmentId) => (
            <ImessageEnvironment
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
