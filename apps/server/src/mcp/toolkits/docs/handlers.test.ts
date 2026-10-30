import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as UserDocs from "../../../userDocs/UserDocs.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as DocsHandlers from "./handlers.ts";
import { DocsToolkit } from "./tools.ts";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-docs"),
  requestNamespace: "session-docs",
  thread: undefined,
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
};

const read = {
  page: "memory",
  title: "Memory",
  heading: null,
  markdown: "text",
  sections: [],
  truncated: false,
  nextCursor: null,
};

const call = (params: object, docs: Partial<UserDocs.UserDocs["Service"]> = {}) =>
  Effect.gen(function* () {
    const toolkit = yield* DocsToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(DocsHandlers.layer)),
    );
    const chunk = yield* toolkit
      .handle("t3_docs", params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return chunk.at(-1)!.result as Record<string, unknown>;
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provide(Layer.mock(UserDocs.UserDocs)(docs)),
  );

it.effect(
  "refuses a request that is missing what its action needs, without touching the guides",
  () =>
    Effect.gen(function* () {
      // Every method throws if called: a refusal must happen before any lookup.
      for (const input of [
        { action: "search" },
        { action: "search", query: "   " },
        { action: "read", heading: "Turn off" },
        { action: "read", cursor: 10 },
      ]) {
        expect(yield* call(input)).toMatchObject({ code: "invalid_request" });
      }
    }),
);

it.effect(
  "passes the query, the default limit and the page arguments through, and lists guides by default",
  () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const docs: Partial<UserDocs.UserDocs["Service"]> = {
        search: (input) => {
          seen.push(input);
          return Effect.succeed({ matches: [], total: 0 });
        },
        read: (input) => {
          seen.push(input);
          return Effect.succeed(read);
        },
        index: Effect.succeed([{ page: "memory", title: "Memory" }]),
      };
      expect(yield* call({ action: "search", query: "memory" }, docs)).toEqual({
        matches: [],
        total: 0,
      });
      yield* call({ action: "search", query: "memory", limit: 20 }, docs);
      yield* call({ action: "read", page: "memory", heading: "Turn off", cursor: 5 }, docs);
      expect(seen).toEqual([
        { query: "memory", limit: 6 },
        { query: "memory", limit: 20 },
        { page: "memory", heading: "Turn off", cursor: 5 },
      ]);
      expect(yield* call({ action: "read" }, docs)).toEqual({
        guides: [{ page: "memory", title: "Memory" }],
      });
    }),
);

it.effect(
  "maps a missing guide or stale cursor to invalid_request and missing guides to a server error",
  () =>
    Effect.gen(function* () {
      expect(
        yield* call(
          { action: "read", page: "nope" },
          {
            read: () =>
              Effect.fail(
                new UserDocs.UserGuideNotFoundError({ page: "nope", nearest: ["memory"] }),
              ),
          },
        ),
      ).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("Nearest: memory"),
      });
      expect(
        yield* call(
          { action: "read", page: "memory", cursor: 9 },
          { read: () => Effect.fail(new UserDocs.UserGuideCursorError()) },
        ),
      ).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("past the end"),
      });
      const unavailable = new UserDocs.UserDocsUnavailableError({
        reason: "this build has no guides",
      });
      for (const input of [
        { action: "search", query: "x" },
        { action: "read" },
        { action: "read", page: "x" },
      ]) {
        expect(
          yield* call(input, {
            search: () => Effect.fail(unavailable),
            index: Effect.fail(unavailable),
            read: () => Effect.fail(unavailable),
          }),
        ).toMatchObject({ code: "orchestration_error" });
      }
    }),
);
