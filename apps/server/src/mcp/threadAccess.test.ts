import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { captureCallerMemoryCeiling, readThread } from "./threadAccess.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

const threadScope = (
  patch: Partial<McpInvocationContext.McpThreadInvocationScope>,
): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "thread-session",
  thread: { threadId: bareId, providerSessionId: "s", providerInstanceId: "p" as never },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  ...patch,
});

it.effect("bounds started work by the caller's own memory grant, never unbounded", () =>
  Effect.gen(function* () {
    const ok = () => Effect.void;
    const ceiling = (scope: McpInvocationContext.McpInvocationScope) =>
      captureCallerMemoryCeiling(scope);
    expect(yield* ceiling(client)).toBe("none");
    expect(yield* ceiling(threadScope({}))).toBe("none");
    expect(
      yield* ceiling(
        threadScope({ grantedScopes: ["memory:read", "memory:write"], reauthorize: ok }),
      ),
    ).toBe("read_write");
    expect(
      yield* ceiling(
        threadScope({
          grantedScopes: ["memory:read", "memory:write"],
          reauthorize: ok,
          readOnly: true,
        }),
      ),
    ).toBe("read");
    expect(yield* ceiling(threadScope({ grantedScopes: [], reauthorize: ok }))).toBe("none");
    const revoked = yield* Effect.exit(
      ceiling(
        threadScope({
          grantedScopes: ["memory:read"],
          reauthorize: () => Effect.fail({ _tag: "EnvironmentAuthorizationError" } as never),
        }),
      ),
    );
    expect(Exit.isFailure(revoked)).toBe(true);
  }),
);
