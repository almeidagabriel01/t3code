import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  compactDynamicToolOutput,
  htmlRenderFromToolItem,
  mcpAppFromToolItem,
  previewRecordingIdFromToolItem,
  toolOutputIndicatesFailure,
} from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSettingsService } from "../serverSettings.ts";

// Outputs this small cost less than the row around them.
const MIN_COMPACTED_OUTPUT_BYTES = 2048;
// The bound WireProjection reads to decide a command without an exit code failed.
const FAILURE_SCAN_CHARS = 32_768;

interface ToolOutputHistoryLimits {
  readonly maxRows: number;
  /** Payload bytes one write transaction may rewrite; a larger single row still goes alone. */
  readonly maxBytes: number;
}

const DEFAULT_LIMITS: ToolOutputHistoryLimits = { maxRows: 200, maxBytes: 4 * 1024 ** 2 };

interface ToolOutputHistoryResult {
  /** Rows marked as examined, rewritten or not. */
  readonly examinedRows: number;
  readonly compactedRows: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

const EMPTY: ToolOutputHistoryResult = {
  examinedRows: 0,
  compactedRows: 0,
  bytesBefore: 0,
  bytesAfter: 0,
};

const formatSize = (bytes: number) =>
  bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Must not read as a failure to `toolOutputIndicatesFailure`. */
const compactedOutputText = (days: number, bytes: number) =>
  `Output removed after ${days} days to save space (was ${formatSize(bytes)}).`;

/**
 * The stored payload with its tool output replaced by a short note, or null to keep it as is.
 * What the work log derives from the output (failure, created threads, app and page references)
 * is kept, so old rows read the same.
 */
export function compactToolOutputPayload(payloadJson: string, days: number): string | null {
  let item: unknown;
  try {
    item = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!Predicate.isObject(item) || item.output === undefined || item.output === null) return null;
  const output = item.output;
  const outputBytes = Buffer.byteLength(
    typeof output === "string" ? output : (JSON.stringify(output) ?? ""),
    "utf8",
  );
  if (outputBytes < MIN_COMPACTED_OUTPUT_BYTES) return null;
  const text = compactedOutputText(days, outputBytes);

  if (item.type === "command_execution") {
    if (typeof output !== "string") return null;
    const failed =
      item.exitCode === undefined &&
      item.outputIndicatesFailure !== true &&
      toolOutputIndicatesFailure(output.slice(0, FAILURE_SCAN_CHARS));
    return JSON.stringify({
      ...item,
      output: text,
      ...(failed ? { outputIndicatesFailure: true } : {}),
    });
  }

  if (item.type === "dynamic_tool") {
    const tool = { toolName: typeof item.toolName === "string" ? item.toolName : null, output };
    // Pages, MCP apps and recordings render from their output and keep attachments alive.
    if (
      htmlRenderFromToolItem(tool) !== undefined ||
      mcpAppFromToolItem(tool) !== undefined ||
      previewRecordingIdFromToolItem(tool) !== undefined
    ) {
      return null;
    }
    const { isError, ...structured } = compactDynamicToolOutput(output) ?? {};
    return JSON.stringify({
      ...item,
      output: {
        content: [{ type: "text", text }],
        ...(isError ? { isError } : {}),
        ...(Object.keys(structured).length > 0 ? { structuredContent: structured } : {}),
      },
    });
  }
  return null;
}

/** One short write transaction over the oldest unexamined tool rows before `cutoff`. */
export const compactToolOutputBatch = Effect.fn("ToolOutputHistory.compactBatch")(
  function* (input: {
    readonly cutoff: string;
    readonly days: number;
    readonly limits?: ToolOutputHistoryLimits;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const { maxRows, maxBytes } = input.limits ?? DEFAULT_LIMITS;
    // octet_length reads the record header, not the payload. Predicate matches migration 82.
    const candidates = yield* sql<{
      readonly turn_item_id: string;
      readonly bytes: number;
    }>`
    SELECT turn_item_id, octet_length(payload_json) AS bytes
    FROM orchestration_v2_projection_turn_items
      INDEXED BY orchestration_v2_projection_turn_items_tool_output_history_idx
    WHERE tool_output_compacted = 0
      AND type IN ('command_execution', 'dynamic_tool')
      AND status NOT IN ('pending', 'running', 'waiting')
      AND updated_at < ${input.cutoff}
    ORDER BY updated_at
    LIMIT ${maxRows}
  `.pipe(NodeSqliteClient.readOnly);
    const ids: string[] = [];
    let selectedBytes = 0;
    for (const candidate of candidates) {
      if (ids.length > 0 && selectedBytes + candidate.bytes > maxBytes) break;
      ids.push(candidate.turn_item_id);
      selectedBytes += candidate.bytes;
    }
    if (ids.length === 0) return EMPTY;

    const rows = yield* sql<{
      readonly turn_item_id: string;
      readonly updated_at: string;
      readonly payload_json: string;
    }>`
    SELECT turn_item_id, updated_at, payload_json
    FROM orchestration_v2_projection_turn_items
    WHERE turn_item_id IN ${sql.in(ids)}
  `.pipe(NodeSqliteClient.readOnly);
    const updates = rows.map((row) => ({
      id: row.turn_item_id,
      updatedAt: row.updated_at,
      before: Buffer.byteLength(row.payload_json, "utf8"),
      payload: compactToolOutputPayload(row.payload_json, input.days),
    }));

    // A row that changed since the read keeps its new updated_at and is picked up again later.
    const written = yield* sql.withTransaction(
      Effect.forEach(updates, (update) =>
        (update.payload === null
          ? sql<{ readonly turn_item_id: string }>`
            UPDATE orchestration_v2_projection_turn_items
            SET tool_output_compacted = 1
            WHERE turn_item_id = ${update.id} AND updated_at = ${update.updatedAt}
              AND tool_output_compacted = 0
            RETURNING turn_item_id
          `
          : sql<{ readonly turn_item_id: string }>`
            UPDATE orchestration_v2_projection_turn_items
            SET tool_output_compacted = 1, payload_json = ${update.payload}
            WHERE turn_item_id = ${update.id} AND updated_at = ${update.updatedAt}
              AND tool_output_compacted = 0
            RETURNING turn_item_id
          `
        ).pipe(Effect.map((result) => (result.length > 0 ? update : null))),
      ),
    );
    return written.reduce<ToolOutputHistoryResult>(
      (total, update) =>
        update === null
          ? total
          : {
              examinedRows: total.examinedRows + 1,
              compactedRows: total.compactedRows + (update.payload === null ? 0 : 1),
              bytesBefore: total.bytesBefore + (update.payload === null ? 0 : update.before),
              bytesAfter:
                total.bytesAfter +
                (update.payload === null ? 0 : Buffer.byteLength(update.payload, "utf8")),
            },
      EMPTY,
    );
  },
);

/**
 * Compacts tool output older than the `toolOutputHistoryDays` setting, batch by batch, until none
 * is left. Examined rows leave the index, so a rerun or a pass resumed after a crash starts where
 * the last committed batch stopped.
 */
export const compactToolOutputHistory = Effect.fn("ToolOutputHistory.compact")(function* (
  betweenBatches: Effect.Effect<void>,
  limits: ToolOutputHistoryLimits = DEFAULT_LIMITS,
) {
  const settings = yield* ServerSettingsService;
  const days = (yield* settings.getSettings).toolOutputHistoryDays;
  if (days === null) return EMPTY;
  const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days }));
  let total = EMPTY;
  while (true) {
    const batch = yield* compactToolOutputBatch({ cutoff, days, limits });
    if (batch.examinedRows === 0) return total;
    total = {
      examinedRows: total.examinedRows + batch.examinedRows,
      compactedRows: total.compactedRows + batch.compactedRows,
      bytesBefore: total.bytesBefore + batch.bytesBefore,
      bytesAfter: total.bytesAfter + batch.bytesAfter,
    };
    yield* Effect.yieldNow;
    yield* betweenBatches;
  }
});
