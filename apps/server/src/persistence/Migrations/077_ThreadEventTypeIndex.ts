import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The memory continuation scan asks for a thread's newest `run.updated`, first `message.updated`
// and whether it is a subagent. Without these each lookup walked every event of the thread and
// read its row, which took tens of seconds on a multi-GB history.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_events_v2_thread_type_sequence_idx
    ON orchestration_events(stream_id, event_type, sequence)
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_events_v2_created_lineage_idx
    ON orchestration_events(stream_id, (json_extract(payload_json, '$.lineage.relationshipToParent')))
    WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND event_type = 'thread.created'
  `;
});
