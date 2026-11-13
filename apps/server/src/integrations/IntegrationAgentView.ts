import {
  type Assistant,
  type DetectedOrigin,
  integrationProviderSupport,
  type IntegrationsState,
  loadedNatively,
  type IntegrationStatus,
  PROVIDER_DISPLAY_NAMES,
} from "@t3tools/contracts";

/** What an agent may know about one integration: names and states, never a credential or address. */
type AgentIntegration = {
  readonly id: string;
  readonly name: string;
  readonly status: IntegrationStatus;
  readonly origins: ReadonlyArray<DetectedOrigin>;
  /** Where it works now; empty means the user still has to connect it. */
  readonly providers: ReadonlyArray<string>;
  readonly assistants: ReadonlyArray<{ readonly handle: string; readonly name: string }>;
};

const T3_PROVIDERS = Object.entries(PROVIDER_DISPLAY_NAMES).flatMap(([driver, name]) =>
  integrationProviderSupport(driver) && name !== undefined ? [name] : [],
);

const NATIVE_PROVIDER: Readonly<Record<DetectedOrigin, string | null>> = {
  "claude-code": "Claude",
  "claude-ai": "Claude",
  codex: "Codex",
  t3: null,
};

/**
 * One row per catalog entry plus T3 integrations outside the catalog. Hand-made T3 servers are left
 * out: agents already see them as their own tools.
 */
export function agentIntegrations(
  state: IntegrationsState,
  assistants: ReadonlyArray<Pick<Assistant, "handle" | "name" | "integrations" | "archivedAt">>,
): ReadonlyArray<AgentIntegration> {
  const active = assistants.filter((assistant) => assistant.archivedAt === null);
  const usedBy = (name: string) =>
    active
      .filter(
        ({ integrations }) => integrations.mode === "all" || integrations.names.includes(name),
      )
      .map(({ handle, name: title }) => ({ handle, name: title }));
  const row = (
    id: string,
    name: string,
    integration: IntegrationsState["integrations"][number] | undefined,
  ): AgentIntegration => {
    const status = integration?.status ?? "not-connected";
    const detected = state.detected.filter(
      (server) => server.catalogId === id && server.origin !== "t3" && server.enabled,
    );
    const native = [...new Set(detected.map((server) => server.origin))];
    return {
      id,
      name,
      status,
      origins: [...(status === "not-connected" ? [] : (["t3"] as const)), ...native],
      providers: [
        ...new Set([
          ...(status === "connected" ? T3_PROVIDERS : []),
          ...detected.flatMap((server) =>
            loadedNatively(server) ? (NATIVE_PROVIDER[server.origin] ?? []) : [],
          ),
        ]),
      ],
      assistants: integration === undefined ? [] : usedBy(integration.name),
    };
  };
  const catalogIds = new Set(state.catalog.map((entry) => entry.id));
  const rows = [
    ...state.catalog.map((entry) => {
      const own = state.integrations.filter((item) => item.catalogId === entry.id);
      return row(entry.id, entry.name, own.find((item) => item.name === entry.id) ?? own[0]);
    }),
    ...state.integrations
      .filter((item) => item.catalogId === null || !catalogIds.has(item.catalogId))
      .map((item) => row(item.name, item.name, item)),
  ];
  const inUse = (item: AgentIntegration) => item.origins.length > 0;
  return [...rows.filter(inUse), ...rows.filter((item) => !inUse(item))];
}
