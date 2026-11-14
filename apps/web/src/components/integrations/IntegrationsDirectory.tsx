import {
  integrationAssistantsUsing,
  integrationCategoryLabel,
  integrationDirectory,
  integrationErrorMessage,
  integrationLinkTarget,
  type IntegrationDirectoryRow,
} from "@t3tools/client-runtime/integrations";
import {
  IntegrationCategory,
  type AssistantIntegrations,
  type DetectedServer,
  type IntegrationBeginConnectResult,
  type IntegrationCatalogEntry,
  type IntegrationsState,
  type IntegrationView,
} from "@t3tools/contracts";
import { BlocksIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { IntegrationActions } from "../../state/integrations";
import { SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { OwnAppDialog, ownAppRedirectUris, PasteDialog, TokenDialog } from "./ConnectDialog";
import {
  DisconnectConfirm,
  IntegrationDetailSheet,
  type IntegrationProviderInstance,
} from "./IntegrationDetailSheet";
import { IntegrationRow, type IntegrationRowMenuAction } from "./IntegrationRow";
import { MakeAvailableDialog } from "./MakeAvailableDialog";

type Category = typeof IntegrationCategory.Type;

interface Flow {
  readonly flowId: string;
  readonly mode: IntegrationBeginConnectResult["mode"];
  readonly title: string;
}

type OpenDialog =
  | {
      readonly kind: "paste";
      readonly flowId: string;
      readonly authorizationUrl: string;
      readonly name: string;
      readonly title: string;
    }
  | {
      readonly kind: "own-app";
      readonly entry: IntegrationCatalogEntry;
      readonly connectAfter: boolean;
    }
  | { readonly kind: "token"; readonly entry: IntegrationCatalogEntry }
  | { readonly kind: "detail"; readonly name: string }
  | { readonly kind: "disconnect"; readonly name: string; readonly title: string }
  | { readonly kind: "make-available"; readonly server: DetectedServer };

const ownAppGroup = (entry: IntegrationCatalogEntry): string | null =>
  entry.auth.kind === "oauth" && entry.auth.registration === "own-app"
    ? entry.auth.clientGroup
    : null;

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** The page origin the server accepts as a callback: HTTPS, or this machine over loopback. */
const callbackPageOrigin = (): string | null => {
  if (window.desktopBridge !== undefined) return null;
  const { protocol, hostname, origin } = window.location;
  return protocol === "https:" || (protocol === "http:" && isLoopbackHost(hostname))
    ? origin
    : null;
};

/** Sends the tab opened during the click to the sign-in page; only http(s) addresses open. */
function openSignIn(tab: Window | null, url: string) {
  if (!/^https?:\/\//i.test(url)) {
    tab?.close();
    return;
  }
  if (tab === null) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  tab.opener = null;
  tab.location.href = url;
}

const showError = (reason: string, title: string) =>
  toastManager.add({ type: "error", title: integrationErrorMessage(reason, title) });

const announceConnected = (title: string, onChooseAssistants: () => void) =>
  toastManager.add({
    type: "success",
    title: "Choose which assistants use it",
    description: title,
    actionProps: { children: "Assistants", onClick: onChooseAssistants },
  });

/**
 * Reports each sign-in this client started once its pushed status leaves "connecting" (finished,
 * failed, expired or cancelled anywhere). Only a status seen as connecting counts, so a push
 * still carrying the state from before the sign-in began does not end it.
 */
function SignInWatcher(props: {
  readonly flows: ReadonlyMap<string, Flow>;
  readonly integrations: ReadonlyArray<IntegrationView>;
  readonly onEnded: (name: string, flow: Flow, status: IntegrationView["status"] | null) => void;
}) {
  const seen = useRef(new Set<string>());
  const ended = useRef(new Set<string>());
  const { flows, integrations, onEnded } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a sign-in ends on the server, so this client learns it only from the pushed status; ending the local listener and dialog is the side effect
  useEffect(() => {
    for (const [name, flow] of flows) {
      const status = integrations.find((integration) => integration.name === name)?.status ?? null;
      if (status === "connecting") {
        seen.current.add(flow.flowId);
        continue;
      }
      if (!seen.current.has(flow.flowId) || ended.current.has(flow.flowId)) continue;
      ended.current.add(flow.flowId);
      onEnded(name, flow, status);
    }
  }, [flows, integrations, onEnded]);
  return null;
}

/** The Integrations directory of one environment and every connect, detail and consent flow. */
export function IntegrationsDirectory(props: {
  readonly state: IntegrationsState;
  /** A catalog id from a link: opens its detail, or searches for it when T3 does not hold it. */
  readonly entry?: string | undefined;
  readonly actions: IntegrationActions;
  readonly assistants: ReadonlyArray<{
    readonly name: string;
    readonly integrations: AssistantIntegrations;
  }>;
  readonly providers: ReadonlyArray<IntegrationProviderInstance>;
  readonly onCustomServers: () => void;
  readonly onChooseAssistants: () => void;
}) {
  const { state, actions } = props;
  const linked = () =>
    props.entry === undefined ? null : integrationLinkTarget(state, props.entry);
  const [query, setQuery] = useState(() => {
    const target = linked();
    return target?.kind === "search" ? target.query : "";
  });
  const [category, setCategory] = useState<Category | null>(null);
  const [flows, setFlows] = useState<ReadonlyMap<string, Flow>>(new Map());
  const [open, setOpen] = useState<OpenDialog | null>(() => {
    const target = linked();
    return target?.kind === "detail" ? { kind: "detail", name: target.name } : null;
  });
  // Loopback listeners stopped because the sign-in already ended on the server.
  const endedByPush = useRef(new Set<string>());
  const directory = integrationDirectory(state, { query, category });
  const entryById = (catalogId: string) =>
    state.catalog.find((entry) => entry.id === catalogId) ?? null;

  const track = (name: string, flow: Flow | null) =>
    setFlows((current) => {
      const next = new Map(current);
      if (flow === null) next.delete(name);
      else next.set(name, flow);
      return next;
    });
  const onFlowEnded = (name: string, flow: Flow, status: IntegrationView["status"] | null) => {
    track(name, null);
    if (status === "connected" && flow.mode === "server") {
      announceConnected(flow.title, props.onChooseAssistants);
    }
    const bridge = window.desktopBridge;
    if (flow.mode === "loopback" && bridge) {
      endedByPush.current.add(flow.flowId);
      void bridge.cancelIntegrationCallback();
    }
    if (open?.kind === "paste" && open.flowId === flow.flowId) setOpen(null);
  };

  const finish = async (name: string, flowId: string, title: string, callbackUrl: string) => {
    const result = await actions.completeConnect({ flowId, callbackUrl });
    if (result.ok) {
      track(name, null);
      announceConnected(title, props.onChooseAssistants);
    }
    return result;
  };

  const startFlow = async (
    entry: IntegrationCatalogEntry,
    options: { readonly busy?: boolean; readonly tab?: Window | null } = {},
  ): Promise<void> => {
    const bridge = window.desktopBridge;
    // Opened during the click, before any await, so popup blockers let it through.
    const tab = options.tab !== undefined ? options.tab : bridge ? null : window.open("", "_blank");
    const begun = await actions.beginConnect({
      catalogId: entry.id,
      client: bridge
        ? { kind: "desktop", loopback: true, ...(options.busy ? { loopbackBusy: true } : {}) }
        : { kind: "web", origin: window.location.origin },
    });
    if (!begun.ok) {
      tab?.close();
      if (begun.reason === "own-app-required") {
        setOpen({ kind: "own-app", entry, connectAfter: true });
      } else showError(begun.reason, entry.name);
      return;
    }
    const flow = begun.value;
    track(flow.name, { flowId: flow.flowId, mode: flow.mode, title: entry.name });
    if (flow.mode === "loopback" && bridge) {
      const received = await bridge.receiveIntegrationCallback({
        authorizationUrl: flow.authorizationUrl,
        redirectUri: flow.redirectUri,
      });
      if (received.status === "received") {
        const result = await finish(flow.name, flow.flowId, entry.name, received.callbackUrl);
        if (!result.ok) {
          track(flow.name, null);
          showError(result.reason, entry.name);
        }
        return;
      }
      track(flow.name, null);
      if (endedByPush.current.has(flow.flowId)) return;
      await actions.cancelConnect(flow.name);
      if (received.status === "port-busy" && !options.busy) {
        return startFlow(entry, { busy: true });
      }
      if (received.status === "expired") showError("sign-in-expired", entry.name);
      else if (received.status !== "cancelled") showError("exchange-failed", entry.name);
      return;
    }
    openSignIn(tab, flow.authorizationUrl);
    if (flow.mode !== "server") {
      setOpen({
        kind: "paste",
        flowId: flow.flowId,
        authorizationUrl: flow.authorizationUrl,
        name: flow.name,
        title: entry.name,
      });
    }
  };

  const connect = (entry: IntegrationCatalogEntry) => {
    if (entry.auth.kind === "token") return setOpen({ kind: "token", entry });
    const group = ownAppGroup(entry);
    if (group !== null && !state.ownApps.some((app) => app.clientGroup === group)) {
      return setOpen({ kind: "own-app", entry, connectAfter: true });
    }
    void startFlow(entry);
  };

  const cancel = async (name: string, title: string) => {
    const flow = flows.get(name);
    const bridge = window.desktopBridge;
    // The listener then reports "cancelled", and its flow cancels the server side.
    if (flow?.mode === "loopback" && bridge) return bridge.cancelIntegrationCallback();
    track(name, null);
    const result = await actions.cancelConnect(name);
    if (!result.ok) showError(result.reason, title);
  };

  const onMenu = (row: IntegrationDirectoryRow, action: IntegrationRowMenuAction) => {
    if (action.kind === "make-available") {
      const server = row.detected.find((candidate) => candidate.id === action.detectedId);
      if (server) setOpen({ kind: "make-available", server });
    } else if (action.kind === "disconnect") {
      setOpen({ kind: "disconnect", name: action.name, title: row.title });
    } else if (row.entry !== null) {
      setOpen(
        action.kind === "use-token"
          ? { kind: "token", entry: row.entry }
          : { kind: "own-app", entry: row.entry, connectAfter: false },
      );
    }
  };

  const renderRow = (row: IntegrationDirectoryRow) => {
    const primary = row.primary;
    const addedInT3 = row.entry === null && row.detected.some((server) => server.origin === "t3");
    const action =
      primary === null || primary.kind === "open" ? null : primary.kind === "cancel" ? (
        <Button
          size="xs"
          variant="outline"
          disabled={!actions.canAct}
          onClick={() => void cancel(primary.name, row.title)}
        >
          {primary.label}
        </Button>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={!actions.canAct || (primary.kind === "connect" && primary.disabled)}
          onClick={() => {
            const entry = entryById(primary.catalogId);
            if (entry) connect(entry);
          }}
        >
          {primary.label}
        </Button>
      );
    const reason = primary?.kind === "connect" ? primary.reason : null;
    return (
      <IntegrationRow
        key={row.key}
        row={row.note === null && reason !== null ? { ...row, note: reason } : row}
        onOpen={
          primary?.kind === "open"
            ? () => setOpen({ kind: "detail", name: primary.name })
            : addedInT3
              ? props.onCustomServers
              : null
        }
        action={action}
        menu={
          row.entry !== null && ownAppGroup(row.entry) !== null
            ? [...row.menu, { kind: "own-app", label: "Use your own app" }]
            : row.menu
        }
        onMenu={(menuAction) => onMenu(row, menuAction)}
        disabled={!actions.canAct}
      />
    );
  };

  const section = (title: string, rows: ReadonlyArray<IntegrationDirectoryRow>) =>
    rows.length === 0 ? null : (
      <SettingsSection title={title}>{rows.map(renderRow)}</SettingsSection>
    );

  const detail =
    open?.kind === "detail"
      ? (state.integrations.find((integration) => integration.name === open.name) ?? null)
      : null;
  const detailEntry =
    detail === null || detail.catalogId === null ? null : entryById(detail.catalogId);
  const ownApp = open?.kind === "own-app" ? ownAppGroup(open.entry) : null;
  const nothingMatches =
    (query.trim() !== "" || category !== null) &&
    directory.connected.length + directory.available.length + directory.other.length === 0;
  const ownAppUsers = state.integrations.flatMap((integration) => {
    const catalogEntry = integration.catalogId === null ? null : entryById(integration.catalogId);
    return ownApp !== null &&
      catalogEntry !== null &&
      ownAppGroup(catalogEntry) === ownApp &&
      integration.status !== "not-connected"
      ? [catalogEntry.name]
      : [];
  });

  return (
    <div className="@container/integrations flex flex-col gap-8">
      <SettingsSection
        {...searchableSetting("integrations")}
        icon={<BlocksIcon className="size-4 text-muted-foreground" />}
      >
        <div className="flex flex-col gap-3 p-3 @md/integrations:p-4">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              placeholder="Search integrations"
              aria-label="Search integrations"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
          <ToggleGroup
            aria-label="Categories"
            variant="pill"
            size="compact"
            className="flex-wrap"
            value={[category ?? "all"]}
            onValueChange={(next) => {
              const value = next[0];
              setCategory(
                value === undefined || value === "all"
                  ? null
                  : (IntegrationCategory.literals.find((item) => item === value) ?? null),
              );
            }}
          >
            {[null, ...IntegrationCategory.literals].map((item) => (
              <Toggle key={item ?? "all"} value={item ?? "all"}>
                {integrationCategoryLabel(item)}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      </SettingsSection>
      {nothingMatches ? (
        <p className="px-3 text-sm text-muted-foreground">No integrations match your search.</p>
      ) : null}
      {section("Connected", directory.connected)}
      {section("Available", directory.available)}
      <SettingsSection
        title="Other"
        className="[&>[data-slot=settings-group]:empty]:hidden"
        headerAction={
          <Button size="xs" variant="outline" onClick={props.onCustomServers}>
            <PlusIcon />
            Add custom server
          </Button>
        }
      >
        {directory.other.map(renderRow)}
        {directory.sourceNotes.map((note) => (
          <p
            key={`${note.origin}:${note.instanceId ?? ""}:${note.path ?? ""}`}
            className="px-3 py-2 text-xs text-muted-foreground @md/integrations:px-4"
          >
            {[note.label, note.path].filter((part) => part !== null).join(" ")}
            {note.reason === null ? null : `: ${note.reason}`}
          </p>
        ))}
      </SettingsSection>
      {open?.kind === "paste" ? (
        <PasteDialog
          name={open.title}
          onOpenSignIn={() => openSignIn(null, open.authorizationUrl)}
          onComplete={async (callbackUrl) => {
            const result = await finish(open.name, open.flowId, open.title, callbackUrl);
            if (result.ok) setOpen(null);
            return result;
          }}
          onClose={() => {
            setOpen(null);
            track(open.name, null);
            void actions.cancelConnect(open.name);
          }}
        />
      ) : null}
      {open?.kind === "own-app" && ownApp !== null ? (
        <OwnAppDialog
          entry={open.entry}
          clientGroup={ownApp}
          saved={state.ownApps.find((app) => app.clientGroup === ownApp) ?? null}
          redirectUris={ownAppRedirectUris(state, callbackPageOrigin())}
          disconnects={ownAppUsers}
          setupUrl={
            open.entry.auth.kind === "oauth" && open.entry.auth.registration === "own-app"
              ? (open.entry.auth.setupUrl ?? null)
              : null
          }
          onSave={async (input) => {
            const tab =
              open.connectAfter && window.desktopBridge === undefined
                ? window.open("", "_blank")
                : null;
            const result = await actions.saveOwnApp({ clientGroup: ownApp, ...input });
            if (!result.ok) {
              tab?.close();
              return result;
            }
            setOpen(null);
            if (open.connectAfter) void startFlow(open.entry, { tab });
            return result;
          }}
          onRemove={async () => {
            const result = await actions.removeOwnApp(ownApp);
            if (result.ok) setOpen(null);
            return result;
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "token" ? (
        <TokenDialog
          entry={open.entry}
          onSave={async (token) => {
            const result = await actions.saveToken(open.entry.id, token);
            if (result.ok) {
              setOpen(null);
              announceConnected(open.entry.name, props.onChooseAssistants);
            }
            return result;
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "detail" && detail !== null ? (
        <IntegrationDetailSheet
          integration={detail}
          title={detailEntry?.name ?? detail.name}
          icon={detailEntry?.icon ?? null}
          providers={props.providers}
          usedBy={integrationAssistantsUsing(detail.name, props.assistants).map(
            (assistant) => assistant.name,
          )}
          canAct={actions.canAct}
          onAvailability={async (availability) => {
            const result = await actions.update({ name: detail.name, availability });
            if (!result.ok) showError(result.reason, detailEntry?.name ?? detail.name);
          }}
          onDisconnect={() =>
            setOpen({
              kind: "disconnect",
              name: detail.name,
              title: detailEntry?.name ?? detail.name,
            })
          }
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "disconnect" ? (
        <DisconnectConfirm
          title={open.title}
          assistantsUsing={integrationAssistantsUsing(open.name, props.assistants).length}
          onConfirm={() => actions.disconnect(open.name)}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "make-available" ? (
        <MakeAvailableDialog
          server={open.server}
          onConfirm={async () => {
            const result = await actions.makeAvailable(open.server.id);
            if (result.ok && result.value.outcome === "copied") setOpen(null);
            return result;
          }}
          onConnect={(catalogId) => {
            setOpen(null);
            const entry = entryById(catalogId);
            if (entry) connect(entry);
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
      <SignInWatcher flows={flows} integrations={state.integrations} onEnded={onFlowEnded} />
    </div>
  );
}
