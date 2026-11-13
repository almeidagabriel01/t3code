import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Set once the output-history pass has looked at a row, whether or not it rewrote it.
  yield* sql`
    ALTER TABLE orchestration_v2_projection_turn_items
    ADD COLUMN tool_output_compacted INTEGER NOT NULL DEFAULT 0
  `;
  // Keep this predicate aligned with ToolOutputHistory's candidate query.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_tool_output_history_idx
    ON orchestration_v2_projection_turn_items(updated_at)
    WHERE tool_output_compacted = 0
      AND type IN ('command_execution', 'dynamic_tool')
      AND status NOT IN ('pending', 'running', 'waiting')
  `;
});
