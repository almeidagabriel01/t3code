import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

it("drops JSON noise, merges tagged unions, and keeps null where it is required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("advertises an untagged top-level union of objects as one object", () => {
  const tool = Tool.make("example", {
    parameters: Schema.Union([
      Schema.Struct({}),
      Schema.Struct({ a: Schema.Literal(true) }),
      Schema.Struct({ a: Schema.Literal(true), b: Schema.Literal(true) }),
    ]),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: { a: { type: "boolean", enum: [true] }, b: { type: "boolean", enum: [true] } },
  });
});

it("merges a top-level union that mixes a tagged and an untagged branch, requiring only shared fields", () => {
  const tool = Tool.make("example", {
    parameters: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), x: Schema.String }),
      Schema.Struct({ x: Schema.String, y: Schema.Int }),
    ]),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      kind: { type: "string", enum: ["a"] },
      x: { type: "string" },
      y: { type: "integer" },
    },
    required: ["x"],
  });
});

it("leaves a top-level union with a non-object branch as anyOf, for the registration guard to refuse", () => {
  const tool = Tool.make("example", {
    parameters: Schema.Union([Schema.Struct({ a: Schema.String }), Schema.String]),
  });

  const schema = advertisedJsonSchema(tool) as { type?: string; anyOf?: ReadonlyArray<unknown> };
  expect(schema.type).toBeUndefined();
  expect(schema.anyOf).toHaveLength(2);
});
