import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const McpServerName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/));
export type McpServerName = typeof McpServerName.Type;
export const EnvKey = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
export type EnvKey = typeof EnvKey.Type;
export const HeaderName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/));

export type HeaderName = typeof HeaderName.Type;

export const McpServerUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      const loopback =
        url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
      return (
        (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
        !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(
          value
            .trim()
            .replace(/[\t\n\r]/g, "")
            .replaceAll("\\", "/"),
        ) &&
        !url.username &&
        !url.password &&
        !value.includes("?") &&
        !value.includes("#")
      );
    } catch {
      return false;
    }
  }),
);

const validName = Schema.is(McpServerName);
const validEnvKey = Schema.is(EnvKey);
const validHeaderName = Schema.is(HeaderName);
const secretEnv = Schema.Record(Schema.String, Schema.String)
  .check(Schema.makeFilter((values) => Object.keys(values).every(validEnvKey)))
  .annotateKey({ settingsSecret: true });
const secretHeaders = Schema.Record(Schema.String, Schema.String)
  .check(Schema.makeFilter((values) => Object.keys(values).every(validHeaderName)))
  .annotateKey({ settingsSecret: true });

const enabled = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));
export const T3McpServer = Schema.Union([
  Schema.Struct({
    enabled,
    transport: Schema.Literal("stdio"),
    command: Schema.String.check(Schema.isMinLength(1)),
    args: Schema.Array(Schema.String),
    env: secretEnv,
  }),
  Schema.Struct({
    enabled,
    transport: Schema.Literal("http"),
    url: McpServerUrl,
    headers: secretHeaders,
  }),
]);
export type T3McpServer = typeof T3McpServer.Type;
export const t3McpProviderName = (name: string) => `${name}_t3`;

/** Drivers whose adapters deliver thread connectors; OpenCode, Pi and Muse have no MCP delivery. */
export const T3_MCP_SERVER_SUPPORT: Readonly<
  Record<string, ReadonlyArray<T3McpServer["transport"]>>
> = {
  codex: ["stdio", "http"],
  claudeAgent: ["stdio", "http"],
  cursor: ["stdio", "http"],
  grok: ["stdio"],
  kiro: ["stdio"],
  antigravity: ["stdio", "http"],
  acpRegistry: ["stdio", "http"],
  fx: ["stdio"],
};

export const T3McpServerSettingsFields = {
  mcpServers: Schema.Record(Schema.String, T3McpServer)
    .check(Schema.makeFilter((servers) => Object.keys(servers).every(validName)))
    .pipe(Schema.withDecodingDefault(Effect.succeed({}))),
};
export const T3McpServerSettingsPatchFields = {
  mcpServers: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(T3McpServer)).check(
      Schema.makeFilter((servers) => Object.keys(servers).every(validName)),
    ),
  ),
};
