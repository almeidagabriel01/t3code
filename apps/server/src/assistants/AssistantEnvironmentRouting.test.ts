import { expect, it } from "@effect/vitest";
import {
  type AssistantEnvironmentPreference,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { resolveLaunchEnvironment, type RoutingDeps } from "./AssistantEnvironmentRouting.ts";
import { snapshotFromHostStatus } from "./AutoEnvironmentPicker.ts";

const here = EnvironmentId.make("env-here");
const peer = EnvironmentId.make("env-peer");
const spare = EnvironmentId.make("env-spare");
const threadId = ThreadId.make("assistant:jarvis");
const homeProject = ProjectId.make("project-home");
const peerProject = ProjectId.make("project-peer");

const scopeOf = (
  overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
): McpInvocationContext.McpInvocationScope => ({
  environmentId: here,
  requestNamespace: "provider:jarvis",
  thread: {
    threadId,
    providerSessionId: "s",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  ...overrides,
});

const FAR = DateTime.makeUnsafe("2100-01-01T00:00:00Z");
const PAST = DateTime.makeUnsafe("1960-01-01T00:00:00Z");

interface Setup {
  readonly assistant?: AssistantEnvironmentPreference | null;
  /** Undefined: a direct chat, with no group. */
  readonly team?: AssistantEnvironmentPreference | null;
  readonly workspace?: "host" | "sandbox";
  readonly scope?: "all" | "project";
  readonly linkOrigin?: boolean;
  readonly enabled?: boolean;
  readonly links?: ReadonlyArray<{ id: EnvironmentId; expiresAt: DateTime.Utc }>;
  readonly withLinks?: boolean;
  /** Projects there per environment; missing means none matches. */
  readonly projects?: Partial<Record<EnvironmentId, ProjectId | "scratch">>;
  readonly load?: Ref.Ref<Partial<Record<EnvironmentId, number>>>;
  readonly sql?: Option.Option<SqlClient.SqlClient>;
  /** A link that never answers. */
  readonly silent?: EnvironmentId;
}

const depsOf = (setup: Setup): RoutingDeps => {
  const links = setup.links ?? [{ id: peer, expiresAt: FAR }];
  const loadOf = (id: EnvironmentId) =>
    setup.load === undefined
      ? Effect.undefined
      : Effect.map(Ref.get(setup.load), (load) => load[id]);
  const snapshot = (utilization: number) => ({
    cpu: { count: 8, utilization },
    memory: { totalBytes: 100, availableBytes: 50 },
  });
  return {
    directory: Option.some({
      forThread: () =>
        Effect.succeedSome({
          assistant: {
            workspace: setup.workspace ?? "host",
            scope: setup.scope ?? "all",
            defaultEnvironment: setup.assistant ?? null,
          },
          current: false,
          ...(setup.team === undefined ? {} : { team: { defaultEnvironment: setup.team } }),
        }),
    } as never),
    links:
      setup.withLinks === false
        ? Option.none()
        : Option.some({
            enabled: Effect.succeed(setup.enabled ?? true),
            stored: Effect.succeed(
              links.map((link) => ({
                environmentId: link.id,
                label: `${link.id} box`,
                expiresAt: link.expiresAt,
              })),
            ),
            get: (id: EnvironmentId) =>
              Effect.succeed(
                Option.fromNullishOr(
                  links
                    .filter((link) => link.id === id)
                    .map((link) => ({
                      environmentId: id,
                      label: `${id} box`,
                      expiresAt: link.expiresAt,
                    }))[0],
                ),
              ),
          } as never),
    forwarding: Option.some({
      call: (_scope: unknown, _tool: unknown, id: EnvironmentId) =>
        Effect.flatMap(loadOf(id), (utilization) =>
          utilization === undefined
            ? Effect.fail(new OrchestratorMcpFailure({ code: "orchestration_error", message: "x" }))
            : Effect.succeed(snapshot(utilization)),
        ),
    } as never),
    hostResources: Option.some({
      read: Effect.map(loadOf(here), (utilization) => ({
        sampledAt: 0,
        cpuUtilization: utilization ?? null,
        cpuCount: 8,
        totalMemoryBytes: 100,
        availableMemoryBytes: 50,
      })),
    } as never),
    remoteDelegation: Option.some({
      remoteProject: (_scope: unknown, id: EnvironmentId, projectId: ProjectId | undefined) => {
        if (id === setup.silent) return Effect.never;
        // The assistant's home project has no repository, so it maps to Scratch there.
        const there =
          setup.projects?.[id] ??
          (projectId === undefined || projectId === homeProject ? "scratch" : undefined);
        return there === undefined
          ? Effect.fail(
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "No project there has this repository.",
              }),
            )
          : Effect.succeed(there === "scratch" ? undefined : there);
      },
    } as never),
    sql: setup.sql ?? Option.none(),
    cache: new Map(),
  };
};

const resolve = (
  setup: Setup,
  input: {
    readonly explicit?: EnvironmentId;
    readonly scope?: McpInvocationContext.McpInvocationScope;
    readonly projectId?: ProjectId;
    readonly scratch?: boolean;
    readonly clientRequestId?: string;
  } = {},
) =>
  resolveLaunchEnvironment(depsOf(setup), {
    scope: input.scope ?? scopeOf(),
    threads: {
      getThreadShell: () =>
        Effect.succeed({
          projectId: homeProject,
          ...(setup.linkOrigin === true
            ? { linkOrigin: { sessionId: "s", label: "Mac", access: "full-access" } }
            : {}),
        }),
    } as never,
    explicit: input.explicit,
    clientRequestId: input.clientRequestId,
    projectId: input.projectId,
    scratch: input.scratch,
  });

/** "here", the environment it goes to with its project there, or the failure code. */
const outcome = (setup: Setup, input: Parameters<typeof resolve>[1] = {}) =>
  resolve(setup, input).pipe(
    Effect.map((resolved) =>
      resolved.environmentId === undefined
        ? "here"
        : `${resolved.environmentId}:${resolved.implicit?.projectId ?? (resolved.implicit === undefined ? "explicit" : "scratch")}`,
    ),
    Effect.catch((error) => Effect.succeed(`failed:${error.code}`)),
  );

const linkedScope = scopeOf({
  client: { sessionId: "s", label: "Mac", access: "full-access", linked: true },
});

it.effect.each([
  ["nothing configured runs here", {}, {}, "here"],
  [
    "an assistant default sends it to the peer's Scratch",
    { assistant: peer },
    {},
    "env-peer:scratch",
  ],
  [
    "... to the project there with the same repository",
    { assistant: peer, projects: { [peer]: peerProject } },
    { projectId: ProjectId.make("project-repo") },
    "env-peer:project-peer",
  ],
  [
    "... and to Scratch there when asked for scratch",
    { assistant: peer },
    { scratch: true },
    "env-peer:scratch",
  ],
  ["an explicit environment wins", { assistant: peer }, { explicit: spare }, "env-spare:explicit"],
  ["... even when it is this one", { assistant: peer }, { explicit: here }, "here"],
  ["an assistant default of Local runs here", { assistant: "local" }, {}, "here"],
  ["... and so does this server's own id", { assistant: here }, {}, "here"],
  [
    "a group default wins in a group thread",
    { assistant: "local", team: peer },
    {},
    "env-peer:scratch",
  ],
  [
    "... and inherits the member's when unset",
    { assistant: peer, team: null },
    {},
    "env-peer:scratch",
  ],
  ["a group's Local wins over the member's", { assistant: peer, team: "local" }, {}, "here"],
  [
    "a sandboxed assistant ignores its default",
    { assistant: peer, workspace: "sandbox" },
    {},
    "here",
  ],
  ["a project assistant ignores its default", { assistant: peer, scope: "project" }, {}, "here"],
  ["a thread a link started ignores it", { assistant: peer, linkOrigin: true }, {}, "here"],
  ["a call that came over a link ignores it", { assistant: peer }, { scope: linkedScope }, "here"],
  [
    "linked environments off in the call scope runs here",
    { assistant: peer },
    { scope: scopeOf({ linkedEnvironments: false }) },
    "here",
  ],
  [
    "linked environments off on the server runs here",
    { assistant: peer, enabled: false },
    {},
    "here",
  ],
  [
    "an unlinked default fails",
    { assistant: EnvironmentId.make("env-gone") },
    {},
    "failed:invalid_request",
  ],
  [
    "an expired link fails",
    { assistant: peer, links: [{ id: peer, expiresAt: PAST }] },
    {},
    "failed:invalid_request",
  ],
  [
    "no matching project there fails",
    { assistant: peer },
    { projectId: ProjectId.make("project-repo") },
    "failed:invalid_request",
  ],
  [
    "no links service with a remote default fails",
    { assistant: peer, withLinks: false },
    {},
    "failed:invalid_request",
  ],
  ["no links service with no default runs here", { withLinks: false }, {}, "here"],
] as const)("resolve: %s", ([, setup, input, expected]) =>
  outcome(setup as Setup, input).pipe(Effect.map((result) => expect(result).toBe(expected))),
);

it.effect("resolve: a caller that is not a thread runs here", () =>
  outcome({ assistant: peer }, { scope: scopeOf({ thread: undefined }) }).pipe(
    Effect.map((result) => expect(result).toBe("here")),
  ),
);

it.effect("resolve: the result names the environment's label", () =>
  resolve({ assistant: peer }).pipe(
    Effect.map((resolved) => expect(resolved.implicit?.label).toBe("env-peer box")),
  ),
);

it.effect("resolve: a failure names the environment and how to choose another", () =>
  resolve({ assistant: peer, links: [{ id: peer, expiresAt: PAST }] }).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error.message).toContain("env-peer box");
      expect(error.message).toContain("expired");
      expect(error.message).toContain("Pass environmentId");
    }),
  ),
);

it.effect("auto: with no reading anywhere it runs here", () =>
  outcome({ assistant: "auto" }).pipe(Effect.map((result) => expect(result).toBe("here"))),
);

it.effect("auto: a free peer wins over a loaded local machine", () =>
  Effect.gen(function* () {
    const load = yield* Ref.make<Partial<Record<EnvironmentId, number>>>({
      [here]: 0.9,
      [peer]: 0.1,
    });
    expect(yield* outcome({ assistant: "auto", load })).toBe("env-peer:scratch");
  }),
);

it.effect("auto: an expired link or one without the project is never a candidate", () =>
  Effect.gen(function* () {
    const load = yield* Ref.make<Partial<Record<EnvironmentId, number>>>({
      [here]: 0.9,
      [peer]: 0.1,
      [spare]: 0.1,
    });
    const links = [
      { id: peer, expiresAt: FAR },
      { id: spare, expiresAt: PAST },
    ];
    expect(
      yield* outcome(
        { assistant: "auto", load, links, projects: {} },
        { projectId: ProjectId.make("project-repo") },
      ),
    ).toBe("here");
  }),
);

it.effect("auto: a link that does not answer within 3 s is left out", () =>
  Effect.gen(function* () {
    const load = yield* Ref.make<Partial<Record<EnvironmentId, number>>>({
      [here]: 0.9,
      [peer]: 0.1,
    });
    const fiber = yield* Effect.forkChild(outcome({ assistant: "auto", load, silent: peer }));
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(fiber)).toBe("here");
  }),
);

it.layer(SqlitePersistence.layerMemory)("auto receipts", (it) => {
  it.effect("a retry with the same clientRequestId lands where the first went", () =>
    Effect.gen(function* () {
      const sql = Option.some(yield* SqlClient.SqlClient);
      const load = yield* Ref.make<Partial<Record<EnvironmentId, number>>>({
        [here]: 0.9,
        [peer]: 0.1,
      });
      const setup = { assistant: "auto", load, sql } as const;
      expect(yield* outcome(setup, { clientRequestId: "req-1" })).toBe("env-peer:scratch");
      yield* Ref.set(load, { [here]: 0.1, [peer]: 0.9 });
      // Past the 15 s reading cache, so only the receipt keeps the first choice.
      yield* TestClock.adjust("16 seconds");
      expect(yield* outcome(setup, { clientRequestId: "req-2" })).toBe("here");
      expect(yield* outcome(setup, { clientRequestId: "req-1" })).toBe("env-peer:scratch");
      // A receipt lasts a day.
      yield* TestClock.adjust("25 hours");
      expect(yield* outcome(setup, { clientRequestId: "req-1" })).toBe("here");
    }),
  );
});

it.each([
  [
    "a full reading",
    { cpu: { count: 4, utilization: 0.5 }, memory: { totalBytes: 8, availableBytes: 2 } },
    true,
  ],
  ["no memory", { cpu: { count: 4, utilization: 0.5 } }, false],
  ["not an object", "busy", false],
] as const)("snapshotFromHostStatus: %s", (_, status, usable) => {
  expect(snapshotFromHostStatus(status, 7) !== null).toBe(usable);
});
