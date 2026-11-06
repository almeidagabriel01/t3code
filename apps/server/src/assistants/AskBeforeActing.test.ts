import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { type DecisionError, ProjectId, ThreadId, type Assistant } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DecisionService, layer as decisionsLayer } from "../decisions/DecisionService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { installLayer } from "./AskBeforeActing.ts";
import { AskBeforeActingGate, gateLayer, SEND_DECLINED } from "./AskBeforeActingGate.ts";

const sender = ThreadId.make("assistant:sam:1");
const target = ThreadId.make("thread:agent");
const assistant = {
  id: "sam",
  name: "Sam",
  projectId: ProjectId.make("project:1"),
} as unknown as Assistant;

const threads = Layer.mock(ThreadManagementService)({
  getThreadRecords: () => Effect.succeed({ thread: { title: "Fix the build" } } as never),
});
const layer = installLayer.pipe(
  Layer.provideMerge(gateLayer),
  Layer.provideMerge(decisionsLayer),
  Layer.provide(Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer, threads)),
);

const run = <A>(
  body: (
    ask: (text: string) => Effect.Effect<unknown>,
    decisions: DecisionService["Service"],
  ) => Effect.Effect<A, DecisionError>,
) =>
  Effect.gen(function* () {
    const gate = yield* AskBeforeActingGate;
    const decisions = yield* DecisionService;
    return yield* body(
      (text) => gate.check({ assistant, senderThreadId: sender, targetThreadId: target, text }),
      decisions,
    );
  }).pipe(Effect.provide(layer));

const open = (decisions: DecisionService["Service"]) =>
  decisions
    .list({ threadId: sender })
    .pipe(Effect.map((all) => all.filter((decision) => decision.status === "open")));

it.effect("asks in the assistant's own conversation, once, and refuses meanwhile", () =>
  run((ask, decisions) =>
    Effect.gen(function* () {
      for (const _ of [1, 2]) {
        expect(yield* ask("deploy it")).toMatchObject({
          allowed: false,
          message: expect.stringContaining("Waiting for the user's approval"),
        });
      }
      const [decision, ...rest] = yield* open(decisions);
      expect(rest).toEqual([]);
      expect(decision).toMatchObject({
        fromThreadId: sender,
        title: "Sam wants to send a message to Fix the build",
        context: "deploy it",
        recommended: "deny",
      });
    }),
  ),
);

it.effect("an approval allows exactly one send of the same text, other text asks again", () =>
  run((ask, decisions) =>
    Effect.gen(function* () {
      yield* ask("deploy it");
      const [first] = yield* open(decisions);
      yield* decisions.answer({ decisionId: first!.id, optionId: "accept" });
      expect(yield* ask("deploy it")).toMatchObject({ allowed: true });
      expect(yield* ask("deploy it")).toMatchObject({ allowed: false });
      expect(yield* open(decisions)).toHaveLength(1);
      yield* ask("deploy something else");
      expect(yield* open(decisions)).toHaveLength(2);
    }),
  ),
);

it.effect("a failed send gives the approval back", () =>
  run((ask, decisions) =>
    Effect.gen(function* () {
      yield* ask("deploy it");
      const [first] = yield* open(decisions);
      yield* decisions.answer({ decisionId: first!.id, optionId: "accept" });
      const approval = (yield* ask("deploy it")) as { release: Effect.Effect<void> };
      yield* approval.release;
      expect(yield* ask("deploy it")).toMatchObject({ allowed: true });
    }),
  ),
);

it.effect.each(["deny", "dismiss"] as const)(
  "a %s never sends, and the next attempt asks again",
  (how) =>
    run((ask, decisions) =>
      Effect.gen(function* () {
        yield* ask("deploy it");
        const [first] = yield* open(decisions);
        if (how === "deny") {
          yield* decisions.answer({ decisionId: first!.id, optionId: "deny" });
          expect(yield* ask("deploy it")).toEqual({ allowed: false, message: SEND_DECLINED });
        } else {
          yield* decisions.dismiss(first!.id);
        }
        expect(yield* ask("deploy it")).toMatchObject({ allowed: false });
        expect(yield* open(decisions)).toHaveLength(1);
      }),
    ),
);

it.effect("fails closed while no approval path is installed", () =>
  Effect.gen(function* () {
    const gate = yield* AskBeforeActingGate;
    expect(
      yield* gate.check({ assistant, senderThreadId: sender, targetThreadId: target, text: "x" }),
    ).toMatchObject({ allowed: false });
  }).pipe(Effect.provide(gateLayer)),
);
