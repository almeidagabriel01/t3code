import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  integrationErrorMessage,
  integrationProviderSupport,
  integrationStatusLabel,
  integrationAssistantsUsing,
  notAvailableOnLabel,
} from "@t3tools/client-runtime/integrations";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  INTEGRATIONS_CALLBACK_PATH,
  type EnvironmentId,
  type IntegrationCatalogEntry,
  type IntegrationsState,
} from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Keyboard, Linking, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAssistantEntries } from "../../state/assistants";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useIntegrationsState } from "../../state/integrations";
import { usePreparedConnection } from "../../state/session";
import { ChoiceRow, TextField } from "../assistants/AssistantFormFields";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { completePastedConnect } from "./connectFlow";
import { IntegrationChip, IntegrationIcon } from "./IntegrationParts";
import {
  connectedNoticeAtom,
  useIntegrationFlows,
  type IntegrationRouteParams,
} from "./useIntegrationFlows";

type Flows = ReturnType<typeof useIntegrationFlows>;

interface FormProps {
  readonly environmentId: EnvironmentId;
  readonly state: IntegrationsState;
  readonly flows: Flows;
  readonly params: IntegrationRouteParams;
  readonly done: () => void;
}

const ownAppGroup = (entry: IntegrationCatalogEntry | null) =>
  entry?.auth.kind === "oauth" && entry.auth.registration === "own-app"
    ? entry.auth.clientGroup
    : null;

function Header(props: {
  readonly title: string;
  readonly icon: IntegrationCatalogEntry["icon"] | null;
  readonly status?: string;
  readonly note?: string | null;
}) {
  const status = props.status === undefined ? null : integrationStatusLabel(props.status);
  return (
    <View className="flex-row items-center gap-3 px-2">
      <IntegrationIcon icon={props.icon ?? null} />
      <View className="min-w-0 flex-1 gap-1">
        <Text textRole="headline" className="text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {status === null ? null : <IntegrationChip label={status.label} tone={status.tone} />}
        {props.note ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {props.note}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function ErrorText(props: { readonly message: string | null }) {
  return props.message === null ? null : (
    <Text accessibilityRole="alert" textRole="footnote" className="px-2 text-danger-foreground">
      {props.message}
    </Text>
  );
}

function LinkRow(props: { readonly label: string; readonly url: string }) {
  return (
    <ListSection>
      <ListActionRow
        icon="arrow.up.right.square"
        label={props.label}
        onPress={() => void Linking.openURL(props.url).catch(() => undefined)}
      />
    </ListSection>
  );
}

function DetailForm(props: FormProps) {
  const { state, flows, environmentId } = props;
  const integration = state.integrations.find((item) => item.name === props.params.name);
  const config = useEnvironmentServerConfig(environmentId);
  const assistants = useAssistantEntries()
    .active.filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.assistant);
  const [error, setError] = useState<string | null>(null);
  if (integration === undefined) return null;
  const entry = state.catalog.find((item) => item.id === integration.catalogId) ?? null;
  const title = entry?.name ?? integration.name;
  const providers = (config?.providers ?? []).filter((provider) => provider.enabled);
  const worksOn = [
    ...new Set(
      providers
        .filter((provider) => integrationProviderSupport(provider.driver))
        .map((provider) => resolveProviderInstanceDisplayName(provider)),
    ),
  ];
  const notOn = [
    ...new Set(
      providers
        .filter((provider) => !integrationProviderSupport(provider.driver))
        .map((provider) => resolveProviderInstanceDisplayName(provider)),
    ),
  ];
  const usedBy = integrationAssistantsUsing(integration.name, assistants);
  const setAvailability = async (availability: "assistants" | "all") => {
    if (availability === integration.availability) return;
    const reply = await flows.actions.update({ name: integration.name, availability });
    setError(reply.ok ? null : integrationErrorMessage(reply.reason, title));
  };
  return (
    <>
      <Header
        title={title}
        icon={entry?.icon ?? null}
        status={integration.status}
        note={
          integration.lastError === undefined
            ? null
            : integrationErrorMessage(integration.lastError, title)
        }
      />
      {integration.expiresAt === undefined && integration.scope === undefined ? null : (
        <ListSection>
          {integration.expiresAt === undefined ? null : (
            <ListRowLayout
              label="Expires"
              detail={new Date(integration.expiresAt).toLocaleString()}
            />
          )}
          {integration.scope === undefined ? null : (
            <ListRowLayout label="Access" description={integration.scope} />
          )}
        </ListSection>
      )}
      <ListSection title="Available to">
        <ChoiceRow
          role="radio"
          icon="person.2"
          label="Assistants only"
          selected={integration.availability === "assistants"}
          onPress={() => void setAvailability("assistants")}
        />
        <ChoiceRow
          role="radio"
          icon="text.bubble"
          label="All threads"
          selected={integration.availability === "all"}
          onPress={() => void setAvailability("all")}
        />
      </ListSection>
      <ErrorText message={error} />
      {providers.length === 0 ? null : (
        <ListSection title="Works on">
          {worksOn.map((name) => (
            <ListRowLayout key={name} icon="checkmark.circle" label={name} />
          ))}
          {notOn.map((name) => (
            <ListRowLayout
              key={name}
              icon="slash.circle"
              label={notAvailableOnLabel(name)}
              disabled
            />
          ))}
        </ListSection>
      )}
      {usedBy.length === 0 ? null : (
        <ListSection title="Used by">
          {usedBy.map((assistant) => (
            <ListRowLayout key={assistant.id} icon="robot" label={assistant.name} />
          ))}
        </ListSection>
      )}
      <ListSection>
        {ownAppGroup(entry) === null || entry === null ? null : (
          <ListActionRow
            icon="key"
            label="Use your own app"
            onPress={() => flows.open({ form: "own-app", catalogId: entry.id })}
          />
        )}
        <ListActionRow
          icon="xmark"
          tone="danger"
          label="Disconnect"
          disabled={!flows.canAct}
          onPress={() => flows.disconnect(integration.name, title, props.done)}
        />
      </ListSection>
    </>
  );
}

function OwnAppForm(props: FormProps) {
  const { state, flows, environmentId } = props;
  const entry = state.catalog.find((item) => item.id === props.params.catalogId) ?? null;
  const clientGroup = ownAppGroup(entry);
  const app = state.ownApps.find((item) => item.clientGroup === clientGroup) ?? null;
  const connection = usePreparedConnection(environmentId);
  const [clientId, setClientId] = useState(app?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (entry === null || clientGroup === null || entry.auth.kind !== "oauth") return null;
  const setupUrl = entry.auth.registration === "own-app" ? entry.auth.setupUrl : undefined;
  const base =
    connection._tag === "Some" && URL.canParse(connection.value.httpBaseUrl)
      ? new URL(connection.value.httpBaseUrl)
      : null;
  const redirectUris = [
    ...new Set([
      ...(base?.protocol === "https:" ? [`${base.origin}${INTEGRATIONS_CALLBACK_PATH}`] : []),
      state.loopbackRedirectUri,
    ]),
  ];
  const leaving = state.integrations
    .filter((item) => {
      const itemEntry = state.catalog.find((candidate) => candidate.id === item.catalogId);
      return ownAppGroup(itemEntry ?? null) === clientGroup;
    })
    .map((item) => item.name);
  const save = async () => {
    setSaving(true);
    const reply = await flows.actions.saveOwnApp({
      clientGroup,
      clientId: clientId.trim(),
      ...(secret === "" ? {} : { clientSecret: secret }),
    });
    setSaving(false);
    if (!reply.ok) return setError(integrationErrorMessage(reply.reason, entry.name));
    props.done();
    await flows.signIn(entry.id);
  };
  const remove = () => {
    Keyboard.dismiss();
    Dialog.alert("Remove app", leaving.length === 0 ? undefined : leaving.join(", "), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove app",
        style: "destructive",
        onPress: () =>
          void flows.actions.removeOwnApp(clientGroup).then((reply) => {
            if (reply.ok) props.done();
            else setError(integrationErrorMessage(reply.reason, entry.name));
          }),
      },
    ]);
  };
  return (
    <>
      <Header title={entry.name} icon={entry.icon ?? null} />
      {setupUrl === undefined ? null : <LinkRow label={new URL(setupUrl).host} url={setupUrl} />}
      <ListSection title="Redirect URIs to register">
        {redirectUris.map((uri) => (
          <View key={uri} className="flex-row items-center bg-grouped-card pe-2">
            <View className="min-w-0 flex-1">
              <ListRowLayout label={uri} labelTruncatesStart />
            </View>
            <IconButton
              accessibilityLabel="Copy"
              icon="doc.on.doc"
              onPress={() => void Clipboard.setStringAsync(uri).catch(() => undefined)}
            />
          </View>
        ))}
      </ListSection>
      <TextField label="Client ID" value={clientId} autoCapitalize="none" onChange={setClientId} />
      <TextField
        label="Client secret"
        value={secret}
        secure
        autoCapitalize="none"
        placeholder={app?.hasClientSecret ? "Saved" : undefined}
        onChange={setSecret}
      />
      <ErrorText message={error} />
      <Button
        label="Connect"
        tone="primary"
        fullWidth
        loading={saving}
        disabled={!flows.canAct || clientId.trim() === "" || saving}
        onPress={() => void save()}
      />
      {app === null ? null : (
        <ListSection>
          <ListActionRow
            icon="trash"
            tone="danger"
            label="Remove app"
            disabled={!flows.canAct}
            onPress={remove}
          />
        </ListSection>
      )}
    </>
  );
}

function TokenForm(props: FormProps) {
  const { state, flows } = props;
  const entry = state.catalog.find((item) => item.id === props.params.catalogId) ?? null;
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (entry === null) return null;
  const tokenUrl =
    entry.auth.kind === "token" ? entry.auth.tokenUrl : entry.tokenFallback?.tokenUrl;
  const saved = state.integrations.some(
    (item) => item.catalogId === entry.id && item.auth === "token",
  );
  const save = async () => {
    setSaving(true);
    const reply = await flows.actions.saveToken(entry.id, token.trim());
    setSaving(false);
    if (!reply.ok) return setError(integrationErrorMessage(reply.reason, entry.name));
    appAtomRegistry.set(connectedNoticeAtom, {
      environmentId: props.environmentId,
      name: reply.value.name,
    });
    props.done();
  };
  return (
    <>
      <Header title={entry.name} icon={entry.icon ?? null} />
      {tokenUrl === undefined ? null : <LinkRow label="Create a token" url={tokenUrl} />}
      <TextField
        label="Token"
        value={token}
        secure
        autoCapitalize="none"
        placeholder={saved ? "Saved" : undefined}
        onChange={setToken}
      />
      <ErrorText message={error} />
      <Button
        label="Connect"
        tone="primary"
        fullWidth
        loading={saving}
        disabled={!flows.canAct || token.trim() === "" || saving}
        onPress={() => void save()}
      />
    </>
  );
}

function PasteForm(props: FormProps) {
  const { state, flows } = props;
  const flow = flows.pendingFlow(props.params.name ?? "");
  const entry = state.catalog.find((item) => item.id === props.params.catalogId) ?? null;
  const title = entry?.name ?? props.params.name ?? "";
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (flow === null) return;
    setSaving(true);
    const reply = await completePastedConnect(flow, text, flows.deps);
    setSaving(false);
    if (!reply.ok) return setError(integrationErrorMessage(reply.reason, title));
    appAtomRegistry.set(connectedNoticeAtom, {
      environmentId: props.environmentId,
      name: flow.name,
    });
    props.done();
  };
  const cancel = async () => {
    await flows.cancel(flow?.name ?? "");
    props.done();
  };
  return (
    <>
      <Header title={title} icon={entry?.icon ?? null} />
      {flow === null ? (
        <ErrorText message={integrationErrorMessage("sign-in-expired", title)} />
      ) : (
        <>
          <TextField
            label="Paste the address from the browser"
            value={text}
            multiline
            autoCapitalize="none"
            onChange={(value) => {
              setText(value);
              setError(null);
            }}
          />
          <ErrorText message={error} />
          <Button
            label="Connect"
            tone="primary"
            fullWidth
            loading={saving}
            disabled={!flows.canAct || text.trim() === "" || saving}
            onPress={() => void submit()}
          />
          <Button label="Cancel" fullWidth onPress={() => void cancel()} />
        </>
      )}
    </>
  );
}

const FORMS = { detail: DetailForm, "own-app": OwnAppForm, token: TokenForm, paste: PasteForm };
const TITLES = {
  detail: "Integrations",
  "own-app": "Use your own app",
  token: "Use a token instead",
  paste: "Integrations",
} as const;

/** One integration: its details once connected, or the own-app, token or paste step of Connect. */
export function IntegrationRouteScreen({ route }: StaticScreenProps<IntegrationRouteParams>) {
  const params = route.params;
  const environmentId = params.environmentId as EnvironmentId;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const state = useIntegrationsState(environmentId);
  const flows = useIntegrationFlows(environmentId, state);
  const Form = FORMS[params.form];
  return (
    <SettingsScreen title={TITLES[params.form]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {state === null ? null : (
          <Form
            environmentId={environmentId}
            state={state}
            flows={flows}
            params={params}
            done={() => navigation.goBack()}
          />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
