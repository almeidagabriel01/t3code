import {
  AssistantMcpServerName,
  assistantMcpServersProblem,
  type AssistantMcpServer,
  type AssistantMcpServerInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const CONNECTOR_TRANSPORT_LABELS = { http: "HTTP", stdio: "Command" } as const;

/** Which providers take them: Grok and Kiro skip http connectors, OpenCode takes none. */
export const CONNECTORS_PROVIDER_NOTE =
  "Connectors work with Claude, Codex, Cursor and Antigravity assistants. Grok and Kiro run command connectors only; OpenCode ignores them.";

/** A header or variable. `saved` rows hold a secret the server never sends back. */
export interface ConnectorRowDraft {
  /** Stable React key: `saved-<n>` for a stored row, a counter for a new one. */
  readonly id: string;
  readonly key: string;
  /** Empty on a saved row keeps the stored value. */
  readonly value: string;
  readonly saved: boolean;
}

export interface ConnectorDraft {
  readonly name: string;
  readonly transport: "http" | "stdio";
  readonly url: string;
  readonly command: string;
  /** One argument per line. */
  readonly args: string;
  readonly headers: ReadonlyArray<ConnectorRowDraft>;
  readonly env: ReadonlyArray<ConnectorRowDraft>;
  readonly enabled: boolean;
}

export const emptyConnectorDraft = (): ConnectorDraft => ({
  name: "",
  transport: "http",
  url: "",
  command: "",
  args: "",
  headers: [],
  env: [],
  enabled: true,
});

let newRows = 0;
export const newConnectorRow = (): ConnectorRowDraft => ({
  id: `new-${++newRows}`,
  key: "",
  value: "",
  saved: false,
});

const rowsFrom = (rows: AssistantMcpServer["headers"]): ReadonlyArray<ConnectorRowDraft> =>
  rows.map((row, index) => ({
    id: `saved-${index}`,
    key: row.key,
    value: "",
    saved: row.hasValue,
  }));

export const connectorDraftsFrom = (
  servers: ReadonlyArray<AssistantMcpServer>,
): ReadonlyArray<ConnectorDraft> =>
  servers.map((server) => ({
    name: server.name,
    transport: server.transport,
    url: server.url ?? "",
    command: server.command ?? "",
    args: server.args.join("\n"),
    headers: rowsFrom(server.headers),
    env: rowsFrom(server.env),
    enabled: server.enabled,
  }));

const rowInputs = (rows: ReadonlyArray<ConnectorRowDraft>) =>
  rows
    .filter((row) => row.key.trim() !== "")
    .map((row) => ({ key: row.key.trim(), ...(row.value === "" ? {} : { value: row.value }) }));

/** What the server stores: a row left empty keeps its saved value; removing a row deletes it. */
export const connectorInputsFrom = (
  drafts: ReadonlyArray<ConnectorDraft>,
): ReadonlyArray<AssistantMcpServerInput> =>
  drafts.map((draft) =>
    draft.transport === "http"
      ? {
          name: draft.name.trim(),
          transport: "http",
          url: draft.url.trim(),
          headers: rowInputs(draft.headers),
          enabled: draft.enabled,
        }
      : {
          name: draft.name.trim(),
          transport: "stdio",
          command: draft.command.trim(),
          args: draft.args
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== ""),
          env: rowInputs(draft.env),
          enabled: draft.enabled,
        },
  );

const isName = Schema.is(AssistantMcpServerName);

/** The first reason these drafts cannot be saved, or null. */
export const connectorDraftsProblem = (drafts: ReadonlyArray<ConnectorDraft>): string | null => {
  const bad = drafts.find((draft) => !isName(draft.name.trim()));
  if (bad !== undefined)
    return "Name each connector with lowercase letters, numbers, dashes or underscores (up to 32).";
  return assistantMcpServersProblem(connectorInputsFrom(drafts));
};

export const connectorsEqual = (
  a: ReadonlyArray<ConnectorDraft>,
  b: ReadonlyArray<ConnectorDraft>,
): boolean => JSON.stringify(a) === JSON.stringify(b);
