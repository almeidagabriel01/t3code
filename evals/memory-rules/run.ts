#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as M from "@t3tools/contracts";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ClaudeTextGeneration from "../../apps/server/src/textGeneration/ClaudeTextGeneration.ts";
import { memoryRuleCases } from "./cases.ts";
import { casePasses, grade } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string", default: "claude-haiku-5-5" },
    out: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "1" },
    baseline: { type: "string" },
  },
});
if (!values.out) throw new Error("Use --out <directory>.");
const outputDirectory = values.out;
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1)
  throw new Error("--samples must be a positive integer.");
const only = values.case?.split(",");
const selected = memoryRuleCases.filter((entry) => !only || only.includes(entry.id));
const unknown = only?.filter((id) => !memoryRuleCases.some((entry) => entry.id === id));
if (unknown?.length) throw new Error(`Unknown case: ${unknown.join(", ")}`);

const instanceId = M.ProviderInstanceId.make("claudeAgent");
const environmentId = M.EnvironmentId.make("memory-rules-eval");
const decodeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const BaselineRows = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: Schema.String, pass: Schema.Boolean })),
);
const memoryId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-rules-" });
    const generation = yield* ClaudeTextGeneration.makeClaudeTextGeneration(
      yield* decodeSettings({}),
      undefined,
      undefined,
      { providerInstanceId: instanceId, environmentId },
    );
    const baseline = values.baseline
      ? yield* fs
          .readFileString(values.baseline)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(BaselineRows)))
      : [];
    const rows = [];
    for (const entry of selected) {
      const ids = new Map(entry.existing?.map((rule, i) => [rule.memoryId, memoryId(i + 1)]));
      const input = M.GenerateMemorySummaryInput.make({
        cwd,
        sourceThread: { environmentId, threadId: M.ThreadId.make(`eval-${entry.id}`) },
        sourceWatermark: {
          fromEventId: M.EventId.make("e1"),
          toEventId: M.EventId.make("e2"),
          throughSequence: 2,
        },
        messages: entry.messages.map((message) => ({
          messageId: M.MessageId.make(message.id),
          text: message.text,
          completed: true,
        })),
        modelSelection: M.MemoryModelSelection.make({
          instanceId,
          model: values.model,
          options: [],
        }),
        rules: {
          userTypedMessageIds: entry.messages
            .filter((message) => message.role === "user")
            .map((message) => M.MessageId.make(message.id)),
          existing: (entry.existing ?? []).map((rule) => ({
            ...rule,
            memoryId: M.MemoryId.make(ids.get(rule.memoryId)!),
          })),
        },
      });
      const back = new Map([...ids].map(([name, uuid]) => [uuid, name]));
      for (let sample = 1; sample <= samples; sample++) {
        const outcome = yield* generation.generateMemorySummary!(input).pipe(Effect.result);
        const row =
          outcome._tag === "Failure"
            ? {
                id: entry.id,
                sample,
                pass: false,
                reason: `error: ${outcome.failure.detail}`,
                rules: [],
              }
            : (() => {
                const rules = (outcome.success.rules ?? []).map((rule) => ({
                  ...rule,
                  supersedes:
                    rule.supersedes === null
                      ? null
                      : (back.get(rule.supersedes) ?? rule.supersedes),
                }));
                return { id: entry.id, sample, ...grade(entry.expect, rules), rules };
              })();
        rows.push(row);
        yield* Effect.log(`${entry.id} #${sample}: ${row.pass ? "pass" : "FAIL"} ${row.reason}`);
      }
    }
    const lines = ["| Case | Pass | Samples | Baseline |", "| --- | --- | --- | --- |"];
    for (const entry of selected) {
      const own = rows.filter((row) => row.id === entry.id);
      const before = baseline.filter((row) => row.id === entry.id);
      lines.push(
        `| ${entry.id} | ${casePasses(own) ? "pass" : "FAIL"} | ${own.filter((row) => row.pass).length}/${own.length} | ${
          before.length ? `${before.filter((row) => row.pass).length}/${before.length}` : "-"
        } |`,
      );
    }
    const summary = `# Memory rules\n\nModel: ${values.model}. Cost: not reported by the memory generation interface.\n\n${lines.join("\n")}\n`;
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(outputDirectory, "results.json"),
      yield* encodeReport(rows),
    );
    yield* fs.writeFileString(path.join(outputDirectory, "summary.md"), summary);
    yield* Effect.log(`\n${summary}`);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
