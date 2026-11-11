import { DeviceOperationError } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { AgentDaemonEndpoint } from "./DeviceHost.ts";

const encodeEndpoint = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      daemonBaseUrl: Schema.String,
      daemonAuthToken: Schema.String,
      stateDir: Schema.optionalKey(Schema.String),
    }),
  ),
);

const key = Effect.fn("AgentDeviceTarget.key")(function* (value: string) {
  const crypto = yield* Digest.Digest;
  const digest = yield* crypto
    .digest(Digest.sha256, new TextEncoder().encode(value))
    .pipe(Effect.orDie);
  return Hex.encode(digest).slice(0, 24);
});

/**
 * A stable file per host lets forwarded endpoints change without retargeting
 * other commands. Hosts with a daemon per device get a file per device.
 */
export const agentDeviceConfigPath = (
  stateDir: string,
  hostId: string,
  path: Path.Path,
  deviceId?: string,
) =>
  key(deviceId === undefined ? hostId : JSON.stringify([hostId, deviceId])).pipe(
    Effect.map((hash) => path.join(stateDir, "device", "hosts", `${hash}.json`)),
  );

/** Names the hold marker of one device; the same name for every thread's launcher on it. */
export const agentDeviceHoldName = (hostId: string, deviceId: string) =>
  key(JSON.stringify(["hold", hostId, deviceId]));

export const agentDeviceSession = (threadId: string, hostId: string, deviceId: string) =>
  key(JSON.stringify([threadId, hostId, deviceId])).pipe(Effect.map((hash) => `t3-${hash}`));

export const writeAgentDeviceConfig = Effect.fn("AgentDeviceTarget.writeConfig")(function* (
  file: string,
  endpoint: AgentDaemonEndpoint & { readonly stateDir?: string | undefined },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const content = yield* encodeEndpoint({
    daemonBaseUrl: endpoint.baseUrl,
    daemonAuthToken: endpoint.token,
    ...(endpoint.stateDir === undefined ? {} : { stateDir: endpoint.stateDir }),
  });
  if ((yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))) === content) return;
  const temporary = yield* fs.makeTempFile({ directory: path.dirname(file), prefix: ".endpoint-" });
  yield* Effect.gen(function* () {
    yield* fs.chmod(temporary, 0o600);
    yield* fs.writeFileString(temporary, content);
    yield* fs.rename(temporary, file);
  }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
});

const AgentCommandResult = Schema.Union([
  Schema.Struct({ result: Schema.Struct({ ok: Schema.Literal(true) }) }),
  Schema.Struct({
    error: Schema.Struct({
      message: Schema.optional(Schema.String),
      data: Schema.optional(
        Schema.Struct({
          code: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
          details: Schema.optional(Schema.Struct({ reason: Schema.optional(Schema.String) })),
        }),
      ),
    }),
  }),
]);

/** The daemon answered with an error: its code, such as `DEVICE_IN_USE`, and the runner's reason. */
export class AgentDeviceCommandRejected extends Schema.TaggedError<AgentDeviceCommandRejected>()(
  "AgentDeviceCommandRejected",
  {
    code: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
    detail: Schema.String,
  },
) {}

/** One `agent_device.command` on a running daemon; fails with what the daemon refused. */
export const agentDeviceCommand =
  (http: HttpClient.HttpClient, endpoint: AgentDaemonEndpoint) =>
  (
    request: {
      readonly session: string;
      readonly command: string;
      readonly positionals: ReadonlyArray<string>;
      readonly input?: Readonly<Record<string, unknown>> | undefined;
      readonly flags?: Readonly<Record<string, string>> | undefined;
    },
    timeout: Duration.Input,
  ) =>
    HttpClientRequest.post(`${endpoint.baseUrl}/rpc`).pipe(
      HttpClientRequest.bearerToken(endpoint.token),
      HttpClientRequest.bodyJson({
        jsonrpc: "2.0",
        id: request.session,
        method: "agent_device.command",
        params: {
          command: request.command,
          session: request.session,
          positionals: request.positionals,
          ...(request.input ? { input: request.input } : {}),
          flags: request.flags ?? {},
        },
      }),
      Effect.flatMap((body) => http.pipe(HttpClient.withScope).execute(body)),
      // The daemon answers a refused command with an error status and the same JSON-RPC body.
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AgentCommandResult)),
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.mapError(
        (cause) =>
          new DeviceOperationError({ operation: request.command, reason: "request_failed", cause }),
      ),
      Effect.flatMap((answer) =>
        "result" in answer
          ? Effect.void
          : Effect.fail(
              new AgentDeviceCommandRejected({
                ...(answer.error.data?.code ? { code: answer.error.data.code } : {}),
                ...(answer.error.data?.details?.reason
                  ? { reason: answer.error.data.details.reason }
                  : {}),
                detail:
                  answer.error.data?.message ??
                  answer.error.message ??
                  "agent-device refused the command.",
              }),
            ),
      ),
    );

/** Ends an agent-device session on a running daemon; an already-released session succeeds. */
export const releaseAgentDeviceSession =
  (http: HttpClient.HttpClient, endpoint: AgentDaemonEndpoint) => (session: string) =>
    agentDeviceCommand(http, endpoint)(
      { session, command: "close", positionals: [] },
      Duration.seconds(15),
    ).pipe(
      Effect.catchTags({
        AgentDeviceCommandRejected: (rejected) =>
          rejected.code === "SESSION_NOT_FOUND"
            ? Effect.void
            : Effect.fail(
                new DeviceOperationError({
                  operation: "close",
                  reason: "request_failed",
                  cause: rejected,
                }),
              ),
      }),
    );
