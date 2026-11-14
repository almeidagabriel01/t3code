import { OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { compactDynamicToolOutput, toolOutputIndicatesFailure } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerSettingsService } from "../serverSettings.ts";
import * as Sqlite from "./Sqlite.ts";
import * as ToolOutputHistory from "./ToolOutputHistory.ts";

const now = DateTime.makeUnsafe("2026-11-13T00:00:00.000Z");
const old = DateTime.formatIso(DateTime.subtract(now, { days: 40 }));
const recent = DateTime.formatIso(DateTime.subtract(now, { days: 5 }));
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

const insertItem = (
  id: string,
  updatedAt: string,
  fields: Record<string, unknown> & { readonly type: string },
  status = "completed",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({
      id,
      threadId: "thread-1",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status,
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt,
      ...fields,
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${id}, 'thread-1', 0, ${fields.type}, ${status}, ${updatedAt}, ${payload})
    `;
    return payload;
  });

const payloadOf = (id: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly payload_json: string; readonly tool_output_compacted: number }>`
      SELECT payload_json, tool_output_compacted FROM orchestration_v2_projection_turn_items
      WHERE turn_item_id = ${id}
    `,
  ).pipe(Effect.map((rows) => rows[0]!));

const bigText = (label: string) => `${label}\n${"x".repeat(5000)}`;
const readTool = (output: unknown) => ({
  type: "dynamic_tool",
  toolName: "Read",
  input: { file_path: "/repo/a.ts" },
  output,
});

const layer = (days: number | null) =>
  Layer.merge(Sqlite.layerMemory, ServerSettingsService.layerTest({ toolOutputHistoryDays: days }));

it.effect("compacts old tool output once and leaves recent work and messages alone", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(now));
    const sql = yield* SqlClient.SqlClient;
    yield* insertItem("old-command", old, {
      type: "command_execution",
      input: "cat missing.txt",
      output: bigText("cat: missing.txt: No such file or directory"),
    });
    yield* insertItem("old-read", old, readTool({ type: "file", file: { content: bigText("a") } }));
    const createdThreads = {
      structuredContent: { threadId: "thread-created", padding: bigText("p") },
      isError: true,
    };
    yield* insertItem("old-t3", old, {
      type: "dynamic_tool",
      toolName: "mcp__t3__create_thread",
      input: {},
      output: createdThreads,
    });
    const tiny = yield* insertItem("old-tiny", old, readTool("ok"));
    const fresh = yield* insertItem("recent-read", recent, readTool(bigText("fresh")));
    const running = yield* insertItem("old-running", old, readTool(bigText("live")), "running");
    const message = yield* insertItem("old-message", old, {
      type: "assistant_message",
      output: bigText("never a tool"),
    });

    const result = yield* ToolOutputHistory.compactToolOutputHistory(Effect.void);
    assert.equal(result.compactedRows, 3);
    assert.equal(result.examinedRows, 4);
    assert.isBelow(result.bytesAfter, result.bytesBefore / 5);

    const command = yield* payloadOf("old-command");
    const commandItem = yield* decodeItem(command.payload_json);
    assert.equal(commandItem.type, "command_execution");
    if (commandItem.type !== "command_execution") return;
    assert.match(commandItem.output ?? "", /^Output removed after 30 days/);
    assert.isFalse(toolOutputIndicatesFailure(commandItem.output ?? ""));
    // No exit code: the failure only the old output showed must survive it.
    assert.isTrue(commandItem.outputIndicatesFailure);
    assert.equal(commandItem.input, "cat missing.txt");

    const readItem = yield* decodeItem((yield* payloadOf("old-read")).payload_json);
    assert.equal(readItem.type, "dynamic_tool");
    if (readItem.type !== "dynamic_tool") return;
    assert.deepEqual(readItem.input, { file_path: "/repo/a.ts" });
    assert.deepEqual(readItem.output, {
      content: [{ type: "text", text: "Output removed after 30 days to save space (was 5 KB)." }],
    });

    const t3Item = yield* decodeItem((yield* payloadOf("old-t3")).payload_json);
    if (t3Item.type !== "dynamic_tool") return assert.fail("expected a dynamic tool");
    // The work log's summary and failure state come from these fields.
    assert.deepEqual(
      compactDynamicToolOutput(t3Item.output),
      compactDynamicToolOutput(createdThreads),
    );

    assert.deepEqual(yield* payloadOf("old-tiny"), {
      payload_json: tiny,
      tool_output_compacted: 1,
    });
    assert.deepEqual(yield* payloadOf("recent-read"), {
      payload_json: fresh,
      tool_output_compacted: 0,
    });
    assert.deepEqual(yield* payloadOf("old-running"), {
      payload_json: running,
      tool_output_compacted: 0,
    });
    assert.equal((yield* payloadOf("old-message")).payload_json, message);

    const before = yield* sql`SELECT * FROM orchestration_v2_projection_turn_items ORDER BY 1`;
    assert.equal((yield* ToolOutputHistory.compactToolOutputHistory(Effect.void)).examinedRows, 0);
    assert.deepEqual(
      yield* sql`SELECT * FROM orchestration_v2_projection_turn_items ORDER BY 1`,
      before,
    );
  }).pipe(Effect.provide(layer(30))),
);

it.effect("does nothing when old tool output is kept", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(now));
    const payload = yield* insertItem("old-read", old, readTool(bigText("kept")));
    yield* ToolOutputHistory.compactToolOutputHistory(Effect.void);
    assert.deepEqual(yield* payloadOf("old-read"), {
      payload_json: payload,
      tool_output_compacted: 0,
    });
  }).pipe(Effect.provide(layer(null))),
);

it.effect("bounds each batch by rows and bytes, and the next batch continues", () =>
  Effect.gen(function* () {
    for (const id of ["a", "b", "c", "d"]) {
      yield* insertItem(id, old, readTool(bigText(id)));
    }
    const batch = (maxRows: number, maxBytes: number) =>
      ToolOutputHistory.compactToolOutputBatch({
        cutoff: recent,
        days: 30,
        limits: { maxRows, maxBytes },
      }).pipe(Effect.map((result) => result.examinedRows));
    const rowBytes = (yield* payloadOf("a")).payload_json.length;

    assert.equal(yield* batch(1, 1024 ** 2), 1);
    assert.equal(yield* batch(10, rowBytes + 1), 1);
    // A row larger than the byte bound still goes, alone.
    assert.equal(yield* batch(10, 1), 1);
    assert.equal(yield* batch(10, 1024 ** 2), 1);
    assert.equal(yield* batch(10, 1024 ** 2), 0);
  }).pipe(Effect.provide(layer(30))),
);

it("keeps outputs that pages, MCP apps and recordings render from", () => {
  const padding = "x".repeat(4000);
  for (const [toolName, output] of [
    [
      "mcp__t3-code__html_render",
      [
        {
          type: "text",
          text: JSON.stringify({
            htmlRender: { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 },
            message: padding,
          }),
        },
      ],
    ],
    [
      "weather.get_weather",
      {
        t3McpApp: {
          attachmentId: "thread-1-abc-html",
          server: "weather",
          tool: "get_weather",
          resourceUri: "ui://weather/dashboard",
        },
        result: { content: [{ type: "text", text: padding }] },
      },
    ],
    ["preview_recording_stop", { id: "thread-1-recording", note: padding }],
  ] as const) {
    const payload = JSON.stringify({ type: "dynamic_tool", toolName, input: {}, output });
    assert.isNull(ToolOutputHistory.compactToolOutputPayload(payload, 30), toolName);
  }
});
