#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as M from "@t3tools/contracts";
import { obedienceCases } from "./obedienceCases.ts";
import { casePasses, gradeObedience } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string", default: "claude-haiku-5-5" },
    out: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "1" },
    text: { type: "string", default: "new" },
  },
});
if (!values.out) throw new Error("Use --out <directory>.");
const samples = Number(values.samples);
const only = values.case?.split(",");
const selected = obedienceCases.filter((entry) => !only || only.includes(entry.id));
if (only && selected.length !== only.length) throw new Error("Unknown case.");

// `--text old` loads the memory context text from before the standing-rules change.
const OLD_REF = "80fb9ca86e^";
const memoryContextPath = "packages/provider-core/src/server/memoryContext.ts";
const MemoryContext: typeof import("../../packages/provider-core/src/server/memoryContext.ts") =
  values.text === "old"
    ? await (async () => {
        const dir = NodePath.join(import.meta.dirname, "..", "runs", ".old-memory-context");
        NodeFS.mkdirSync(dir, { recursive: true });
        const file = NodePath.join(dir, "memoryContext.ts");
        NodeFS.writeFileSync(
          file,
          NodeChildProcess.execFileSync("git", ["show", `${OLD_REF}:${memoryContextPath}`], {
            encoding: "utf8",
          }),
        );
        return import(file);
      })()
    : await import("../../packages/provider-core/src/server/memoryContext.ts");
// The old module has no MEMORY_SYSTEM_NOTICE; the adapter then sent the boundary reminder.
const systemNotice =
  (MemoryContext as Partial<typeof MemoryContext>).MEMORY_SYSTEM_NOTICE ??
  MemoryContext.MEMORY_DATA_BOUNDARY_REMINDER;

const log = (text: string) => process.stdout.write(`${text}\n`);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-memory-obedience-"));
const rows: Array<{ id: string; sample: number; pass: boolean; reason: string; answer: string }> =
  [];
for (const entry of selected) {
  const snapshot = MemoryContext.packMemoryContext({
    memorySpaceId: M.MemorySpaceId.make(uuid(1)),
    projectionWatermark: 1,
    items: entry.memories.map((memory, i) => ({
      memoryId: M.MemoryId.make(uuid(10 + i)),
      revisionId: M.MemoryRevisionId.make(uuid(20 + i)),
      scope: { kind: "user" },
      provenance: { environmentId: M.EnvironmentId.make("memory-rules-eval") },
      assertionKind: "inference",
      text: memory.text,
    })),
  });
  if (!snapshot) throw new Error(`Case ${entry.id} packed no memory.`);
  const prompt = `${entry.question}\n\n${MemoryContext.memoryContextText(snapshot)}`;
  for (let sample = 1; sample <= samples; sample++) {
    const run = NodeChildProcess.spawnSync(
      "claude",
      [
        "-p",
        "--model",
        values.model,
        "--append-system-prompt",
        systemNotice,
        "--tools",
        "",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
      ],
      { input: prompt, cwd, encoding: "utf8" },
    );
    const answer = run.status === 0 ? run.stdout : "";
    const graded =
      run.status === 0
        ? gradeObedience(entry.expect, answer)
        : { pass: false, reason: `claude failed: ${run.stderr.slice(0, 200)}` };
    rows.push({ id: entry.id, sample, ...graded, answer });
    log(
      `${entry.id} #${sample}: ${graded.pass ? "pass" : "FAIL"} ${JSON.stringify(answer.trim())}`,
    );
  }
}
const lines = ["| Case | Pass | Samples |", "| --- | --- | --- |"];
for (const entry of selected) {
  const own = rows.filter((row) => row.id === entry.id);
  lines.push(
    `| ${entry.id} | ${casePasses(own) ? "pass" : "FAIL"} | ${own.filter((r) => r.pass).length}/${own.length} |`,
  );
}
NodeFS.mkdirSync(values.out, { recursive: true });
NodeFS.writeFileSync(NodePath.join(values.out, "results.json"), JSON.stringify(rows, null, 2));
NodeFS.writeFileSync(
  NodePath.join(values.out, "summary.md"),
  `# Memory obedience (${values.text} text)\n\nModel: ${values.model}.\n\n${lines.join("\n")}\n`,
);
log(lines.join("\n"));
