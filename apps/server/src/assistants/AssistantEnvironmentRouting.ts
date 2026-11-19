import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import { AssistantDirectory } from "./AssistantDirectory.ts";
import { pickLeastLoaded, REMOTE_TIMEOUT, type SnapshotCache } from "./AutoEnvironmentPicker.ts";

const RECEIPT_TTL_HOURS = 24;

/** Optional so servers and tests without links or assistants still build; a default then fails loudly. */
export const routingDeps = Effect.gen(function* () {
  return {
    directory: yield* Effect.serviceOption(AssistantDirectory),
    links: yield* Effect.serviceOption(PeerLinks.PeerLinks),
    forwarding: yield* Effect.serviceOption(PeerForwarding.PeerForwarding),
    hostResources: yield* Effect.serviceOption(HostResources.HostResources),
    remoteDelegation: yield* Effect.serviceOption(RemoteDelegation.RemoteDelegation),
    sql: yield* Effect.serviceOption(SqlClient.SqlClient),
    cache: new Map() as SnapshotCache,
  };
});
export type RoutingDeps = Effect.Success<typeof routingDeps>;

export interface ResolvedLaunch {
  /** Undefined runs it here. */
  readonly environmentId: EnvironmentId | undefined;
  /** Set when a default, not the call, sent the work to a linked environment. */
  readonly implicit?: {
    readonly label: string;
    /** The project there; undefined for its Scratch. */
    readonly projectId: ProjectId | undefined;
  };
}

const HERE: ResolvedLaunch = { environmentId: undefined };

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const FOLLOW_UP =
  "Pass environmentId to choose where it runs, or ask the user to change the default environment.";

/**
 * Where a launch or task without `environmentId` runs: an explicit id always wins; an
 * assistant's own thread then uses its group's default (group threads only), its own, or this
 * server. Linked callers, sandboxed and project assistants keep today's rule: here.
 */
export const resolveLaunchEnvironment = Effect.fn("AssistantEnvironmentRouting.resolve")(function* (
  deps: RoutingDeps,
  input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly threads: ThreadManagement.ThreadManagementService["Service"];
    readonly explicit: EnvironmentId | undefined;
    readonly clientRequestId?: string | undefined;
    /** The local project the work names; omitted means the caller's. */
    readonly projectId?: ProjectId | undefined;
    readonly scratch?: boolean | undefined;
  },
) {
  const { scope } = input;
  if (input.explicit !== undefined) {
    return { environmentId: PeerForwarding.remoteTarget(scope, input.explicit) };
  }
  const threadId = scope.thread?.threadId;
  if (threadId === undefined || scope.client?.linked === true || Option.isNone(deps.directory)) {
    return HERE;
  }
  const found = yield* deps.directory.value.forThread(threadId);
  if (Option.isNone(found)) return HERE;
  const { assistant, team } = found.value;
  if (assistant.workspace === "sandbox" || assistant.scope === "project") return HERE;
  const preference = team?.defaultEnvironment ?? assistant.defaultEnvironment ?? "local";
  if (preference === "local" || preference === scope.environmentId) return HERE;
  const shell = yield* input.threads
    .getThreadShell(threadId)
    .pipe(Effect.orElseSucceed(() => null));
  // Work a link started never reaches further links from here.
  if (shell?.linkOrigin !== undefined || scope.linkedEnvironments === false) return HERE;
  const { links, remoteDelegation } = deps;
  if (Option.isNone(links) || Option.isNone(remoteDelegation) || Option.isNone(deps.forwarding)) {
    return yield* refused(
      `This assistant's default environment is ${preference}, and this server cannot reach linked environments. ${FOLLOW_UP}`,
    );
  }
  if (!(yield* links.value.enabled)) return HERE;
  const localProject = input.scratch === true ? undefined : (input.projectId ?? shell?.projectId);
  const now = yield* DateTime.now;

  const remote = Effect.fn("AssistantEnvironmentRouting.remote")(function* (
    environmentId: EnvironmentId,
  ) {
    const link = yield* links.value.get(environmentId).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isNone(link)) {
      return yield* refused(
        `The default environment ${environmentId} is unavailable: it is no longer linked. ${FOLLOW_UP}`,
      );
    }
    const { label } = link.value;
    if (DateTime.isLessThanOrEqualTo(link.value.expiresAt, now)) {
      return yield* refused(
        `The default environment ${label} (${environmentId}) is unavailable: its link expired. ${FOLLOW_UP}`,
      );
    }
    const projectId = yield* remoteDelegation.value
      .remoteProject(scope, environmentId, localProject)
      .pipe(
        Effect.mapError((error) =>
          refused(`Default environment ${label} (${environmentId}): ${error.message} ${FOLLOW_UP}`),
        ),
      );
    return { environmentId, implicit: { label, projectId } } satisfies ResolvedLaunch;
  });

  if (preference !== "auto") return yield* remote(preference);

  const receipt = yield* readReceipt(deps, threadId, input.clientRequestId, now);
  if (receipt !== undefined) {
    return receipt === scope.environmentId ? HERE : yield* remote(receipt);
  }
  const stored = yield* links.value.stored.pipe(Effect.orElseSucceed(() => []));
  const reachable = yield* Effect.filter(
    stored.filter((link) => DateTime.isGreaterThan(link.expiresAt, now)),
    (link) =>
      remoteDelegation.value.remoteProject(scope, link.environmentId, localProject).pipe(
        Effect.timeout(REMOTE_TIMEOUT),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    { concurrency: "unbounded" },
  );
  const chosen =
    (yield* pickLeastLoaded({
      scope,
      candidates: [scope.environmentId, ...reachable.map((link) => link.environmentId)],
      hostResources: deps.hostResources,
      forwarding: deps.forwarding,
      cache: deps.cache,
    })) ?? scope.environmentId;
  yield* writeReceipt(deps, threadId, input.clientRequestId, chosen, now);
  return chosen === scope.environmentId ? HERE : yield* remote(chosen);
});

/** Auto's choice for a retried call, so a retry lands where the first attempt went. */
const readReceipt = (
  deps: RoutingDeps,
  threadId: ThreadId,
  clientRequestId: string | undefined,
  now: DateTime.Utc,
) =>
  Option.isNone(deps.sql) || clientRequestId === undefined
    ? Effect.undefined
    : deps.sql.value<{ readonly environment_id: EnvironmentId }>`
        SELECT environment_id FROM assistant_launch_routes
        WHERE caller_thread_id = ${threadId} AND client_request_id = ${clientRequestId}
          AND created_at > ${DateTime.formatIso(DateTime.subtract(now, { hours: RECEIPT_TTL_HOURS }))}`.pipe(
        Effect.map((rows) => rows[0]?.environment_id),
        Effect.orElseSucceed(() => undefined),
      );

const writeReceipt = (
  deps: RoutingDeps,
  threadId: ThreadId,
  clientRequestId: string | undefined,
  environmentId: EnvironmentId,
  now: DateTime.Utc,
) => {
  if (Option.isNone(deps.sql) || clientRequestId === undefined) return Effect.void;
  const sql = deps.sql.value;
  const cutoff = DateTime.formatIso(DateTime.subtract(now, { hours: RECEIPT_TTL_HOURS }));
  return Effect.all([
    sql`DELETE FROM assistant_launch_routes WHERE created_at <= ${cutoff}`,
    sql`INSERT INTO assistant_launch_routes (caller_thread_id, client_request_id, environment_id, created_at)
        VALUES (${threadId}, ${clientRequestId}, ${environmentId}, ${DateTime.formatIso(now)})
        ON CONFLICT (caller_thread_id, client_request_id)
        DO UPDATE SET environment_id = excluded.environment_id, created_at = excluded.created_at`,
  ]).pipe(Effect.ignoreCause({ log: true }));
};
