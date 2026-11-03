// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ChatAttachmentId, ProjectId, ThreadId, type ChatFileAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as DecisionAttachmentIntake from "./DecisionAttachmentIntake.ts";
import * as Decisions from "./DecisionService.ts";

const thread = ThreadId.make("thread-1");
const options = [{ id: "yes", label: "Yes" }];

const layer = Decisions.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SqlitePersistence.layerMemory,
      NodeCrypto.layer,
      Layer.mock(ThreadManagement.ThreadManagementService)({
        sendToThread: () => Effect.succeed({} as never),
      }),
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(NodeServices.layer).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-decision-files-" })),
      Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  ),
);

const stage = Effect.fn("test.stage")(function* (name: string) {
  const config = yield* ServerConfig.ServerConfig;
  const id = createPendingAttachmentId("txt");
  NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${id}.txt`), "hello");
  const file: ChatFileAttachment = {
    type: "file",
    id: ChatAttachmentId.make(id),
    name,
    mimeType: "text/plain",
    sizeBytes: 5,
  };
  return { file, dir: config.attachmentsDir };
});

const request = (decisions: Decisions.DecisionService["Service"], approvalRequestId?: string) =>
  decisions.request({
    fromThreadId: thread,
    projectId: ProjectId.make("project-1"),
    threadTitle: "t",
    clientRequestId: approvalRequestId ?? "r",
    title: "Ship it?",
    context: "",
    options,
    approvalRequestId,
  });

it.effect("claims fresh uploads to the requesting thread and keeps them on the answer", () =>
  Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const { file, dir } = yield* stage("notes.txt");
    const decision = yield* request(decisions);
    const answered = yield* DecisionAttachmentIntake.answerDecision({
      decisionId: decision.id,
      attachments: [file],
    });
    const stored = answered.answer?.attachments?.[0];
    assert.isTrue(stored?.id.startsWith("thread-1-") ?? false);
    assert.equal(stored?.name, "notes.txt");
    assert.isTrue(NodeFS.readdirSync(dir).some((entry) => entry.startsWith("thread-1-")));
  }).pipe(Effect.provide(layer)),
);

it.effect("releases claimed files when the decision is no longer open", () =>
  Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const { file, dir } = yield* stage("late.txt");
    const decision = yield* request(decisions);
    yield* decisions.dismiss(decision.id);
    const before = NodeFS.readdirSync(dir).length;
    const error = yield* DecisionAttachmentIntake.answerDecision({
      decisionId: decision.id,
      attachments: [file],
    }).pipe(Effect.flip);
    assert.equal(error.reason, "not_open");
    assert.equal(NodeFS.readdirSync(dir).length, before);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses approval decisions, files that are not fresh uploads, and missing uploads", () =>
  Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const { file } = yield* stage("a.txt");
    const approval = yield* request(decisions, "req-1");
    const forApproval = yield* DecisionAttachmentIntake.answerDecision({
      decisionId: approval.id,
      optionId: "yes",
      attachments: [file],
    }).pipe(Effect.flip);
    assert.include(forApproval.message, "approval");

    const plain = yield* request(decisions);
    const existing = { ...file, id: ChatAttachmentId.make("thread-1-already-sent") };
    const stale = yield* DecisionAttachmentIntake.answerDecision({
      decisionId: plain.id,
      attachments: [existing],
    }).pipe(Effect.flip);
    assert.include(stale.message, "fresh uploads");

    const missing = yield* DecisionAttachmentIntake.answerDecision({
      decisionId: plain.id,
      attachments: [{ ...file, id: ChatAttachmentId.make(createPendingAttachmentId("txt")) }],
    }).pipe(Effect.flip);
    assert.equal(missing.reason, "invalid");

    const heavyImage = {
      ...file,
      type: "image" as const,
      mimeType: "image/png",
      sizeBytes: 81 * 1024 * 1024,
    };
    const tooBig = yield* DecisionAttachmentIntake.answerDecision({
      decisionId: plain.id,
      attachments: [heavyImage],
    }).pipe(Effect.flip);
    assert.include(tooBig.message, "80 MiB");
    assert.equal((yield* decisions.get(plain.id)).status, "open");
  }).pipe(Effect.provide(layer)),
);

it.effect("answers without attachments go straight to the service", () =>
  Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const decision = yield* request(decisions);
    const answered = yield* DecisionAttachmentIntake.answerDecision({
      decisionId: decision.id,
      optionId: "yes",
    });
    assert.equal(answered.status, "answered");
  }).pipe(Effect.provide(layer)),
);
