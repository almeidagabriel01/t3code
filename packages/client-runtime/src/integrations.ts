import {
  integrationProviderSupport,
  worksNatively,
  type AssistantIntegrations,
  type AssistantWorkspace,
  type DetectedOrigin,
  type DetectedServer,
  type IntegrationCatalogEntry,
  IntegrationCategory,
  type IntegrationsState,
  type IntegrationView,
} from "@t3tools/contracts";

type Category = typeof IntegrationCategory.Type;

export type IntegrationTone = "success" | "warning" | "danger" | "muted" | "progress";

export interface IntegrationStatusChip {
  readonly label: string;
  readonly tone: IntegrationTone;
}

const STATUS_CHIPS: Readonly<Record<string, IntegrationStatusChip>> = {
  connected: { label: "Connected", tone: "success" },
  "needs-sign-in": { label: "Needs sign-in", tone: "warning" },
  "needs-more-access": { label: "Needs more access", tone: "warning" },
  error: { label: "Error", tone: "danger" },
  "not-connected": { label: "Not connected", tone: "muted" },
  connecting: { label: "Waiting for sign-in…", tone: "progress" },
};

/** A status from a newer server reads as Error. */
export const integrationStatusLabel = (status: string): IntegrationStatusChip =>
  STATUS_CHIPS[status] ?? { label: "Error", tone: "danger" };

const ERROR_MESSAGES: Readonly<Record<string, (name: string) => string>> = {
  "pkce-unsupported": () => "This service doesn't support secure sign-in (PKCE)",
  "unsupported-auth": () => "This service doesn't support secure sign-in (PKCE)",
  "sign-in-expired": () => "Sign-in expired or didn't match. Try again",
  "invalid-callback": () => "Sign-in expired or didn't match. Try again",
  "unsafe-address": () => "Unsafe sign-in address",
  unreachable: (name) => `${name} didn't respond`,
  "own-app-required": (name) => `${name} needs your own app first`,
  "discovery-failed": (name) => `Couldn't find ${name}'s sign-in page`,
  "registration-unavailable": (name) =>
    `${name} doesn't let T3 sign in on its own. Use your own app or a token`,
  "registration-failed": (name) => `${name} refused T3's sign-in`,
  "sign-in-denied": () => "Sign-in was cancelled",
  "exchange-failed": () => "Sign-in didn't finish. Try again",
  "refresh-failed": () => "Sign-in didn't finish. Try again",
  "invalid-token": (name) => `${name} didn't accept this token`,
  "storage-failed": () => "Couldn't save on the server",
  "unknown-entry": () => "This integration is no longer in the catalog",
  "detected-not-found": () => "This server changed since the list loaded. Check it and try again",
  "not-copyable": () => "This server can't be copied",
  "url-not-allowed": () => "T3 only copies https addresses without ? or #",
  "needs-sign-in": () => "Needs sign-in",
  "not-connected": () => "Not connected",
};

/** `name` is the integration's display name; a reason from a newer server reads as Error. */
export const integrationErrorMessage = (reason: string, name: string): string =>
  ERROR_MESSAGES[reason]?.(name) ?? "Error";

const ORIGIN_LABELS: Readonly<Record<DetectedOrigin, string>> = {
  "claude-code": "Connected in Claude Code",
  codex: "Connected in Codex",
  "claude-ai": "Connected in claude.ai",
  t3: "Added in T3",
};

const ORIGIN_PLACES: Readonly<Record<Exclude<DetectedOrigin, "t3">, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "claude-ai": "claude.ai",
};

type DetectedCopy = Pick<DetectedServer, "origin" | "loaded" | "enabled">;

// Claude reports statuses once, at session start, so "pending" (still starting) is no outcome yet:
// it reads like an unreported copy. Any other status but "connected" means it does not work.
const detectedState = (server: DetectedCopy): "connected" | "needs-sign-in" | "not-connected" =>
  !server.enabled
    ? "not-connected"
    : server.loaded === undefined || server.loaded === "connected" || server.loaded === "pending"
      ? "connected"
      : server.loaded === "needs-auth"
        ? "needs-sign-in"
        : "not-connected";

const detectedWorks = (server: DetectedCopy): boolean => detectedState(server) === "connected";

export function detectedOriginLabel(server: DetectedCopy): string {
  if (server.origin === "t3") return ORIGIN_LABELS.t3;
  const state = detectedState(server);
  return state === "connected"
    ? ORIGIN_LABELS[server.origin]
    : `In ${ORIGIN_PLACES[server.origin]}, ${state === "needs-sign-in" ? "not signed in" : "not connected"}`;
}

/** Null for T3's own servers, which work wherever T3 injects them. */
export const worksInLabel = (origin: DetectedOrigin): string | null =>
  origin === "codex"
    ? "Works in Codex assistants"
    : origin === "t3"
      ? null
      : "Works in Claude assistants";

const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  calendar: "Calendar",
  email: "Email",
  chat: "Chat",
  docs: "Docs",
  tasks: "Tasks",
  files: "Files",
  dev: "Dev",
  design: "Design",
  crm: "CRM",
  payments: "Payments",
  automation: "Automation",
};

/** Null is the chip that clears the filter. */
export const integrationCategoryLabel = (category: Category | null): string =>
  category === null ? "All" : CATEGORY_LABELS[category];

export type IntegrationPrimaryAction =
  /** Starts sign-in for the entry; `reason` explains a disabled one. */
  | {
      readonly kind: "connect";
      readonly label: string;
      readonly catalogId: string;
      readonly disabled: boolean;
      readonly reason: string | null;
    }
  /** The same flow as connect; labelled Retry when the service did not answer. */
  | { readonly kind: "reconnect"; readonly label: string; readonly catalogId: string }
  /** Cancels the pending sign-in of the integration `name`. */
  | { readonly kind: "cancel"; readonly label: string; readonly name: string }
  /** The whole row opens the detail sheet. */
  | { readonly kind: "open"; readonly name: string };

export type IntegrationMenuAction =
  | { readonly kind: "make-available"; readonly label: string; readonly detectedId: string }
  | { readonly kind: "disconnect"; readonly label: string; readonly name: string }
  | { readonly kind: "use-token"; readonly label: string; readonly catalogId: string }
  | { readonly kind: "own-app"; readonly label: string; readonly catalogId: string };

export interface IntegrationOriginChip {
  readonly origin: DetectedOrigin;
  readonly label: string;
  /** False when the label says the copy is not signed in or not connected. */
  readonly works: boolean;
  readonly detectedId: string;
}

export interface IntegrationDirectoryRow {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly icon: { readonly svg: string; readonly color: string } | null;
  readonly entry: IntegrationCatalogEntry | null;
  readonly integration: IntegrationView | null;
  readonly detected: ReadonlyArray<DetectedServer>;
  /** T3's status; null for rows T3 holds nothing for. */
  readonly status: IntegrationStatusChip | null;
  readonly origins: ReadonlyArray<IntegrationOriginChip>;
  readonly note: string | null;
  /** Null: the row is not clickable. */
  readonly primary: IntegrationPrimaryAction | null;
  readonly menu: ReadonlyArray<IntegrationMenuAction>;
}

export interface IntegrationSourceNote {
  readonly origin: DetectedOrigin;
  readonly instanceId: string | null;
  readonly label: string;
  readonly path: string | null;
  readonly reason: string | null;
}

const SOURCE_REASONS: Readonly<Record<string, string>> = {
  "permission-denied": "Permission denied",
  "invalid-format": "Not valid JSON or TOML",
};

const byTitle = (
  left: { readonly title: string; readonly key: string },
  right: { readonly title: string; readonly key: string },
) =>
  left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
  left.key.localeCompare(right.key);

const originChip = (server: DetectedServer): IntegrationOriginChip => ({
  origin: server.origin,
  label: detectedOriginLabel(server),
  works: detectedWorks(server),
  detectedId: server.id,
});

const copyActions = (servers: ReadonlyArray<DetectedServer>): IntegrationMenuAction[] =>
  servers.flatMap((server) =>
    server.copyable
      ? [
          {
            kind: "make-available" as const,
            label: "Make available to all providers",
            detectedId: server.id,
          },
        ]
      : [],
  );

const t3Note = (integration: IntegrationView, title: string): string | null =>
  integration.lastError !== undefined &&
  (integration.status === "error" || integration.status.startsWith("needs-"))
    ? integrationErrorMessage(integration.lastError, title)
    : null;

function catalogRow(
  entry: IntegrationCatalogEntry,
  integration: IntegrationView | null,
  detected: ReadonlyArray<DetectedServer>,
): IntegrationDirectoryRow {
  const native = detected.filter(detectedWorks);
  const status = integration?.status ?? "not-connected";
  const nativeOnly = native.length > 0 && (status === "not-connected" || status === "connecting");
  const connect = (label: string): IntegrationPrimaryAction => {
    const unavailable = entry.availability === "unavailable";
    return {
      kind: "connect",
      label,
      catalogId: entry.id,
      disabled: unavailable,
      reason: unavailable ? (entry.note ?? null) : null,
    };
  };
  const primary: IntegrationPrimaryAction =
    status === "connecting" && integration !== null
      ? { kind: "cancel", label: "Cancel", name: integration.name }
      : status === "connected" && integration !== null
        ? { kind: "open", name: integration.name }
        : status === "not-connected"
          ? connect(
              native.some((server) => server.origin !== "claude-ai")
                ? "Connect for other providers"
                : detected.some((server) => server.origin === "claude-ai")
                  ? "Connect in T3"
                  : "Connect",
            )
          : {
              kind: "reconnect",
              label: integration?.lastError === "unreachable" ? "Retry" : "Reconnect",
              catalogId: entry.id,
            };
  const worksIn = [...new Set(native.flatMap((server) => worksInLabel(server.origin) ?? []))];
  const tokenFallback = entry.tokenFallback !== undefined || entry.auth.kind === "token";
  return {
    key: `catalog:${entry.id}`,
    title: entry.name,
    description: entry.description,
    icon: entry.icon ?? null,
    entry,
    integration,
    detected,
    status: integration === null ? null : integrationStatusLabel(integration.status),
    origins: detected.map(originChip),
    note:
      integration !== null && !nativeOnly
        ? t3Note(integration, entry.name)
        : worksIn.length > 0
          ? worksIn.join(" · ")
          : null,
    primary,
    menu: [
      ...copyActions(detected),
      ...(integration !== null && status !== "connecting"
        ? [{ kind: "disconnect" as const, label: "Disconnect", name: integration.name }]
        : []),
      ...(tokenFallback && status !== "connected"
        ? [{ kind: "use-token" as const, label: "Use a token instead", catalogId: entry.id }]
        : []),
      ...(entry.auth.kind === "oauth" && entry.auth.registration === "own-app"
        ? [{ kind: "own-app" as const, label: "Use your own app", catalogId: entry.id }]
        : []),
    ],
  };
}

/** A T3 integration with no catalog row of its own: its entry left the catalog, or it is a second one. */
function integrationRow(integration: IntegrationView): IntegrationDirectoryRow {
  return {
    key: `integration:${integration.name}`,
    title: integration.name,
    description: "",
    icon: null,
    entry: null,
    integration,
    detected: [],
    status: integrationStatusLabel(integration.status),
    origins: [],
    note: t3Note(integration, integration.name),
    primary:
      integration.status === "connecting"
        ? { kind: "cancel", label: "Cancel", name: integration.name }
        : integration.status === "connected"
          ? { kind: "open", name: integration.name }
          : null,
    menu:
      integration.status === "connecting"
        ? []
        : [{ kind: "disconnect", label: "Disconnect", name: integration.name }],
  };
}

function otherRow(server: DetectedServer): IntegrationDirectoryRow {
  return {
    key: `detected:${server.id}`,
    title: server.name,
    description: server.url ?? server.command ?? "",
    icon: null,
    entry: null,
    integration: null,
    detected: [server],
    status: null,
    origins: [originChip(server)],
    note: detectedWorks(server) ? worksInLabel(server.origin) : null,
    primary: null,
    menu: copyActions([server]),
  };
}

/** Connected is read off the row's own chips, so its header never contradicts them. */
const rowWorks = (row: IntegrationDirectoryRow): boolean =>
  row.integration?.status === "connected" || row.origins.some((origin) => origin.works);

const matches = (row: IntegrationDirectoryRow, query: string): boolean =>
  query === "" ||
  [
    row.title,
    row.description,
    row.entry?.id ?? "",
    row.integration?.name ?? "",
    ...row.detected.map((server) => server.name),
  ].some((text) => text.toLowerCase().includes(query));

/**
 * The Integrations directory. Hand-made T3 servers always land in Other, even with a catalog
 * match: they keep their own name and settings, and no integration of an entry is ever hidden.
 */
export function integrationDirectory(
  state: IntegrationsState,
  filter: { readonly query: string; readonly category: Category | null },
) {
  const query = filter.query.trim().toLowerCase();
  const catalogIds = new Set(state.catalog.map((entry) => entry.id));
  const chosen = new Map<string, IntegrationView>();
  for (const integration of state.integrations) {
    if (integration.catalogId === null || !catalogIds.has(integration.catalogId)) continue;
    const current = chosen.get(integration.catalogId);
    if (current === undefined || integration.name === integration.catalogId) {
      chosen.set(integration.catalogId, integration);
    }
  }
  const connected: IntegrationDirectoryRow[] = [];
  const available: IntegrationDirectoryRow[] = [];
  const other: IntegrationDirectoryRow[] = [];
  const inCategory = (row: IntegrationDirectoryRow) =>
    filter.category === null || row.entry?.category === filter.category;
  for (const entry of state.catalog) {
    const integration = chosen.get(entry.id) ?? null;
    const detected = state.detected.filter(
      (server) => server.catalogId === entry.id && server.origin !== "t3",
    );
    const row = catalogRow(entry, integration, detected);
    if (!inCategory(row) || !matches(row, query)) continue;
    (rowWorks(row) ? connected : available).push(row);
  }
  for (const integration of state.integrations) {
    if (integration.catalogId !== null && chosen.get(integration.catalogId) === integration) {
      continue;
    }
    const row = integrationRow(integration);
    if (!inCategory(row) || !matches(row, query)) continue;
    (rowWorks(row) ? connected : available).push(row);
  }
  for (const server of state.detected) {
    if (server.origin !== "t3" && server.catalogId !== null && catalogIds.has(server.catalogId)) {
      continue;
    }
    const row = otherRow(server);
    if (inCategory(row) && matches(row, query)) other.push(row);
  }
  const sourceNotes: IntegrationSourceNote[] = state.detectionSources.flatMap(
    (source): IntegrationSourceNote[] =>
      source.status === "unreadable"
        ? [
            {
              origin: source.origin,
              instanceId: source.instanceId ?? null,
              label: "Couldn't read",
              path: source.path ?? null,
              reason: SOURCE_REASONS[source.reason ?? ""] ?? "Read failed",
            },
          ]
        : source.origin === "claude-ai" && source.status === "not-seen"
          ? [
              {
                origin: source.origin,
                instanceId: source.instanceId ?? null,
                label: "Not seen yet (open a Claude conversation)",
                path: null,
                reason: null,
              },
            ]
          : [],
  );
  return {
    connected: connected.sort(byTitle),
    available: available.sort(byTitle),
    other: other.sort(byTitle),
    sourceNotes,
  };
}

export { integrationProviderSupport };

/** Where a link to one catalog entry lands: its detail once T3 holds it, otherwise a search for it. */
export function integrationLinkTarget(
  state: IntegrationsState,
  catalogId: string,
):
  | { readonly kind: "detail"; readonly name: string }
  | { readonly kind: "search"; readonly query: string }
  | null {
  const { connected, available } = integrationDirectory(state, { query: "", category: null });
  const row = [...connected, ...available].find((item) => item.entry?.id === catalogId);
  if (row === undefined) return null;
  return row.primary?.kind === "open"
    ? { kind: "detail", name: row.primary.name }
    : { kind: "search", query: row.title };
}

export const notAvailableOnLabel = (providerDisplayName: string): string =>
  `Not available on ${providerDisplayName}`;

// The assistant's own conversation runs here and reaches the proxy; work it starts in the sandbox
// runs on the container's T3 server, which holds none of this server's integrations.
export const sandboxWorkNote = (workspace: AssistantWorkspace): string | null =>
  workspace === "sandbox" ? "Not available in the sandbox" : null;

const nativeNote = (origin: DetectedOrigin): string =>
  origin === "codex"
    ? "Always on for Codex (set up in Codex)"
    : origin === "claude-ai"
      ? "Always on for Claude (set up in claude.ai)"
      : "Always on for Claude (set up in Claude Code)";

export interface AssistantIntegrationItem {
  readonly key: string;
  /** The name a selection holds. */
  readonly name: string;
  readonly title: string;
  readonly status: IntegrationStatusChip | null;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly note: string | null;
}

/**
 * The per-assistant checklist. Native copies loaded in this provider instance are always on, so
 * T3 does not inject its own there (D7); names that no longer exist stay listed (INT-24).
 */
export function assistantIntegrationPicker(input: {
  readonly state: IntegrationsState;
  readonly selection: AssistantIntegrations;
  readonly driverKind: string;
  readonly instanceId: string;
}) {
  const { state, selection } = input;
  const supported = integrationProviderSupport(input.driverKind);
  const isSelected = (name: string) => selection.mode === "all" || selection.names.includes(name);
  // Keyed by catalog entry, so a T3 copy of the same entry reads as always on; others by name.
  const native = new Map<string, DetectedServer>();
  for (const server of state.detected) {
    if (server.instanceId !== input.instanceId || !worksNatively(server)) continue;
    const key = server.catalogId ?? `server:${server.name}`;
    if (!native.has(key)) native.set(key, server);
  }
  const titleOf = (catalogId: string | null, fallback: string) =>
    state.catalog.find((entry) => entry.id === catalogId)?.name ?? fallback;
  const items: AssistantIntegrationItem[] = [];
  for (const integration of state.integrations) {
    const nativeCopy =
      integration.catalogId === null ? undefined : native.get(integration.catalogId);
    items.push({
      key: `integration:${integration.name}`,
      name: integration.name,
      title: titleOf(integration.catalogId, integration.name),
      status: integrationStatusLabel(integration.status),
      selected: nativeCopy !== undefined || isSelected(integration.name),
      disabled: !supported || nativeCopy !== undefined,
      note: nativeCopy === undefined ? null : nativeNote(nativeCopy.origin),
    });
  }
  for (const server of state.detected) {
    if (server.origin !== "t3") continue;
    items.push({
      key: `detected:${server.id}`,
      name: server.name,
      title: server.name,
      status: null,
      selected: isSelected(server.name),
      disabled: !supported,
      note: ORIGIN_LABELS.t3,
    });
  }
  if (selection.mode === "selected") {
    const known = new Set(items.map((item) => item.name));
    for (const name of selection.names) {
      if (known.has(name)) continue;
      items.push({
        key: `missing:${name}`,
        name,
        title: name,
        status: integrationStatusLabel("not-connected"),
        selected: true,
        disabled: !supported,
        note: null,
      });
    }
  }
  const t3CatalogIds = new Set(state.integrations.map((integration) => integration.catalogId));
  for (const [catalogId, server] of native) {
    if (t3CatalogIds.has(catalogId)) continue;
    items.push({
      key: `native:${server.id}`,
      name: server.name,
      title: titleOf(catalogId, server.name),
      status: null,
      selected: true,
      disabled: true,
      note: nativeNote(server.origin),
    });
  }
  return { mode: selection.mode, items: items.sort(byTitle) };
}

/** All mode has no per-name choice, so it stays as it is. */
export const toggleIntegration = (
  selection: AssistantIntegrations,
  name: string,
): AssistantIntegrations =>
  selection.mode === "all"
    ? selection
    : {
        mode: "selected",
        names: selection.names.includes(name)
          ? selection.names.filter((item) => item !== name)
          : [...selection.names, name],
      };

/** Switching to selected starts from what all mode gave, so nothing drops silently. */
export function selectionForMode(
  mode: AssistantIntegrations["mode"],
  current: AssistantIntegrations,
  state: IntegrationsState,
): AssistantIntegrations {
  if (mode === current.mode) return current;
  if (mode === "all") return { mode: "all" };
  const names = [
    ...state.integrations
      .filter((item) => item.status !== "not-connected" && item.status !== "connecting")
      .map((item) => item.name),
    ...state.detected
      .filter((server) => server.origin === "t3" && server.enabled)
      .map((server) => server.name),
  ];
  return { mode: "selected", names: [...new Set(names)] };
}

/** The server reads only the query, so any absolute URL carrying `code` or `error` is accepted. */
export function parsePastedCallback(text: string): string | null {
  const trimmed = text.trim();
  if (!URL.canParse(trimmed)) return null;
  const { searchParams } = new URL(trimmed);
  return searchParams.has("code") || searchParams.has("error") ? trimmed : null;
}

/** Every T3 integration is available to assistants, so all mode always counts. */
export const integrationAssistantsUsing = <
  A extends { readonly integrations: AssistantIntegrations },
>(
  name: string,
  assistants: ReadonlyArray<A>,
): ReadonlyArray<A> =>
  assistants.filter(
    (assistant) =>
      assistant.integrations.mode === "all" || assistant.integrations.names.includes(name),
  );
