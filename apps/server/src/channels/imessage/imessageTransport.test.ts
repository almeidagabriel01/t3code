import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { dmAddress } from "../channelBridgeTestSupport.ts";
import { fingerprintText } from "./imessageAdmission.ts";
import type { ImessageSendFailure } from "./imessageSender.ts";
import { IMESSAGE_CHUNK_LIMIT } from "./imessageText.ts";
import { makeImessageTransport, type ImessageSendReport } from "./imessageTransport.ts";

/** A transport over a fake sender; `script` answers each send with a failure or undefined for success. */
const build = (
  script: (call: number) => ImessageSendFailure | undefined = () => undefined,
  isActive = true,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sent: Array<{ chatGuid: string; text: string }> = [];
    const reports: ImessageSendReport[] = [];
    const transport = makeImessageTransport({
      connectionId: "c1",
      sender: {
        sendText: async (input) => {
          sent.push(input);
          return script(sent.length) ?? { acceptedAt: "2026-01-01T00:00:00.000Z" };
        },
      },
      sql,
      isActive: Effect.succeed(isActive),
      report: (result) => Effect.sync(() => void reports.push(result)),
    });
    return { sql, sent, reports, transport };
  });

const message = (text: string, deliveryId = "d1") => ({
  deliveryId,
  destination: dmAddress,
  senderName: "Jarvis",
  text,
});
const long = Array.from({ length: 3 }, (_, i) => `${i}`.repeat(IMESSAGE_CHUNK_LIMIT - 10)).join(
  "\n\n",
);

it.effect("sends the prefixed plain text and stores a fingerprint before it goes out", () =>
  Effect.gen(function* () {
    const { sql, sent, reports, transport } = yield* build();
    const receipt = yield* transport.send({
      ...message("**Done**"),
      choices: [{ label: "Ok", value: "ok" }],
    });
    const text = "Jarvis: Done\n\n1. Ok\nReply with the number.";
    assert.equal(receipt.deliveryId, "d1");
    assert.deepEqual(sent, [{ chatGuid: dmAddress.chatGuid, text }]);
    assert.deepEqual(reports, [{ ok: true }]);
    const rows = yield* sql<{
      readonly text_hash: string;
      readonly chat_guid: string;
    }>`SELECT text_hash, chat_guid FROM imessage_sent`;
    assert.deepEqual(rows, [{ text_hash: fingerprintText(text), chat_guid: dmAddress.chatGuid }]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a retry after a later piece failed sends only the pieces that did not go out", () =>
  Effect.gen(function* () {
    let failSecond = true;
    const { sent, reports, transport } = yield* build((call) =>
      call === 2 && failSecond ? { outcome: "not_sent", code: "unknown" } : undefined,
    );
    const error = yield* Effect.flip(transport.send(message(long)));
    assert.deepEqual(
      [error.reason, error.deliveryOutcome, error.deliveryErrorCode],
      ["delivery_failed", "not_sent", "unknown"],
    );
    assert.deepEqual(reports, [{ ok: false, code: "unknown" }]);
    failSecond = false;
    yield* transport.send(message(long));
    assert.deepEqual(
      sent.map((piece) => piece.text.slice(0, 12)),
      ["Jarvis: 0000", "Jarvis: 1111", "Jarvis: 1111", "Jarvis: 2222"],
    );
    yield* transport.send(message(long));
    assert.lengthOf(sent, 4);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("an ambiguous timeout keeps its claim so a resend cannot duplicate it", () =>
  Effect.gen(function* () {
    const { sent, transport } = yield* build(() => ({ outcome: "unknown", code: "timeout" }));
    const error = yield* Effect.flip(transport.send(message("hello")));
    assert.deepEqual([error.deliveryOutcome, error.deliveryErrorCode], ["unknown", "timeout"]);
    yield* transport.send(message("hello"));
    assert.lengthOf(sent, 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("refuses another connection or an inactive channel without sending", () =>
  Effect.gen(function* () {
    const { sent, transport } = yield* build(undefined, false);
    const inactive = yield* Effect.flip(transport.send(message("hello")));
    assert.deepEqual(
      [inactive.reason, inactive.deliveryOutcome],
      ["adapter_unavailable", "not_sent"],
    );
    const wrong = yield* Effect.flip(
      transport.send({ ...message("hello"), destination: { ...dmAddress, connectionId: "other" } }),
    );
    assert.equal(wrong.reason, "invalid_input");
    assert.lengthOf(sent, 0);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
