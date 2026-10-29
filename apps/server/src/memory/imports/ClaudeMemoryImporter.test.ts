import { assert, describe, it } from "@effect/vitest";
import * as M from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseClaudeMemory } from "./ClaudeMemoryImporter.ts";
import {
  buildMemoryImportFixture,
  MEMORY_IMPORT_FIXTURE_PARSER_VERSIONS,
  snapshotMemoryImportFiles,
} from "./MemoryImportFixtures.fixture.ts";
import type { ImportParsedItem, ImportSnapshot } from "./MemoryImportTypes.ts";

const decodePayload = Schema.decodeUnknownEffect(M.MemoryPayload);
const topic = (
  body = "Use focused checks.",
  fields = "name: Guidance\ndescription: A synthetic topic\ntype: project",
) => `---\n${fields}\n---\n${body}`;
const files = (snapshot: ImportSnapshot, entries: readonly (readonly [string, string])[]) =>
  snapshotMemoryImportFiles(
    snapshot,
    entries.map(([selector, text]) => ({
      selector,
      text,
      byteCount: new TextEncoder().encode(text).length,
    })),
  );
const candidate = (rows: readonly ImportParsedItem[]) => {
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.kind, "candidate");
  if (row.kind !== "candidate") throw new Error("Expected a candidate");
  return row.candidate;
};
const fixtureTest = (
  name: string,
  test: (snapshot: ImportSnapshot) => Effect.Effect<void, M.MemoryImportRpcError>,
) =>
  it.effect(name, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("claude-topic-v1");
        yield* test(fixture.snapshot);
      }),
    ),
  );
const expectIssue = (snapshot: ImportSnapshot, issue: M.MemoryImportIssue) =>
  Effect.match(parseClaudeMemory(snapshot), {
    onSuccess: () => assert.fail("Expected a typed import refusal"),
    onFailure: (error) => {
      assert.instanceOf(error, M.MemoryImportRpcError);
      assert.equal(error.issue, issue);
      assert.deepEqual(JSON.parse(JSON.stringify(error)), { _tag: "MemoryImportRpcError", issue });
    },
  });

describe("ClaudeMemoryImporter", () => {
  it.effect.each(["claude-topic-v1", "claude-topic-metadata-v1"] as const)(
    "extracts the fixed %s fixture",
    (profile) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* buildMemoryImportFixture(profile);
          assert.equal(
            fixture.snapshot.parserVersion,
            MEMORY_IMPORT_FIXTURE_PARSER_VERSIONS[profile],
          );
          const rows = yield* parseClaudeMemory(fixture.snapshot);
          const item = candidate(rows);
          assert.equal(item.sourceItemKey, "fixture.md#body");
          assert.equal(item.title, "Fixture guidance");
          assert.deepEqual(item.payload.evidence, []);
          assert.deepEqual(item.payload.derivedFromMemoryRevisions, []);
          assert.deepEqual(yield* decodePayload(item.payload), item.payload);
          assert.equal(item.byteCount, new TextEncoder().encode(item.payload.text).length);
          assert.match(item.contentFingerprint, /^[a-f0-9]{64}$/);
          assert.match(item.sourceFingerprint, /^[a-f0-9]{64}$/);
          assert.notInclude(JSON.stringify(item), "synthetic-session");
          assert.deepEqual(yield* parseClaudeMemory(fixture.snapshot), rows);
        }),
      ),
  );

  fixtureTest("supports exactly the four direct types", (snapshot) =>
    Effect.gen(function* () {
      for (const type of ["user", "feedback", "project", "reference"]) {
        candidate(
          yield* parseClaudeMemory(
            files(snapshot, [
              ["topic.md", topic("A fact.", `name: Guidance\ndescription: Topic\ntype: ${type}`)],
            ]),
          ),
        );
      }
    }),
  );

  fixtureTest(
    "canonical body, metadata, version and path have distinct fingerprint roles",
    (snapshot) =>
      Effect.gen(function* () {
        const parse = (text: string, selector = "topic.md", base = snapshot) =>
          Effect.map(parseClaudeMemory(files(base, [[selector, text]])), candidate);
        const a = yield* parse(topic("  Cafe\u0301\r\nKeep case.  "));
        const canonical = yield* parse(topic("Café\nKeep case."));
        assert.deepEqual(a, canonical);
        assert.equal(a.payload.text, "Café\nKeep case.");
        const changed = yield* parse(topic("Changed content."));
        assert.equal(changed.sourceItemKey, a.sourceItemKey);
        assert.notEqual(changed.sourceFingerprint, a.sourceFingerprint);
        assert.notEqual(changed.contentFingerprint, a.contentFingerprint);
        const title = yield* parse(
          topic("Café\nKeep case.", "name: Other\ndescription: A synthetic topic\ntype: project"),
        );
        assert.equal(title.sourceItemKey, a.sourceItemKey);
        assert.equal(title.contentFingerprint, a.contentFingerprint);
        assert.notEqual(title.sourceFingerprint, a.sourceFingerprint);
        const renamed = yield* parse(topic("Café\nKeep case."), "renamed.md");
        assert.notEqual(renamed.sourceItemKey, a.sourceItemKey);
        assert.equal(renamed.sourceFingerprint, a.sourceFingerprint);
        assert.equal(renamed.contentFingerprint, a.contentFingerprint);
        const version = yield* parse(topic("Café\nKeep case."), "topic.md", {
          ...snapshot,
          parserVersion: "future-grammar",
        });
        assert.equal(version.sourceItemKey, a.sourceItemKey);
        assert.equal(version.contentFingerprint, a.contentFingerprint);
        assert.notEqual(version.sourceFingerprint, a.sourceFingerprint);
        const relocated = yield* parse(topic("Café\nKeep case."), "topic.md", {
          ...snapshot,
          sourceLocator: "another/opaque",
          slot: { ...snapshot.slot, selection: "another-opaque" },
        });
        assert.deepEqual(relocated, a);
      }),
  );

  fixtureTest(
    "metadata profile agrees with direct type and ignores foreign session identity",
    (snapshot) =>
      Effect.gen(function* () {
        const base = { ...snapshot, profile: "claude-topic-metadata-v1" };
        const text = (session: string) =>
          topic(
            "Safe body.",
            `name: Topic\ndescription: Safe\ntype: project\nmetadata:\n  type: project\n  node_type: memory\n  originSessionId: ${session}\n  modified: 2026-08-05T18:08:50.727Z-${session}`,
          );
        const a = candidate(yield* parseClaudeMemory(files(base, [["topic.md", text("first")]])));
        const b = candidate(yield* parseClaudeMemory(files(base, [["topic.md", text("second")]])));
        assert.deepEqual(a, b);
        assert.notInclude(JSON.stringify(a), "first");
      }),
  );

  fixtureTest("ignores nested, non-Markdown and wrongly named entries", (snapshot) =>
    Effect.gen(function* () {
      const rows = yield* parseClaudeMemory(
        files(snapshot, [
          ["nested/topic.md", topic()],
          ["session.jsonl", "{}"],
          ["topic.md", topic("[Reference](../../outside.md)\nrollout_path: outside.jsonl")],
        ]),
      );
      assert.equal(
        candidate(rows).payload.text,
        "[Reference](../../outside.md)\nrollout_path: outside.jsonl",
      );
    }),
  );

  // One tolerance per row: whatever the header looks like, the body is the memory.
  const tolerated: readonly (readonly [string, string, string, string])[] = [
    [
      "no frontmatter, heading names it",
      "# Heading name\nSome body.",
      "Heading name",
      "# Heading name\nSome body.",
    ],
    ["no frontmatter, file name names it", "Just body.", "bad", "Just body."],
    ["unknown type", topic("body", "name: T\ndescription: d\ntype: whatever"), "T", "body"],
    ["no type", topic("body", "name: T\ndescription: d"), "T", "body"],
    ["no description", topic("body", "name: T\ntype: user"), "T", "body"],
    ["no name falls back to file name", topic("body", "description: d\ntype: user"), "bad", "body"],
    ["unknown top-level key", topic("body", "name: T\nextra: value\ntype: user"), "T", "body"],
    ["list value", topic("body", "name: T\ntags: [a, b]\nitems:\n  - x\n  - y"), "T", "body"],
    [
      "unknown nested metadata keys",
      topic(
        "body",
        "name: T\nmetadata:\n  type: user\n  modified: 2026-08-05T18:08:50Z\n  node_type: memory\n  future_key: 1\n  nested:\n    deep: 1",
      ),
      "T",
      "body",
    ],
    ["numeric name", topic("body", "name: 123\ndescription: d"), "123", "body"],
    ["anchor and tag", topic("body", "name: &a T\nd: !!str x\ndescription: *a"), "T", "body"],
    ["duplicate key", topic("body", "name: First\nname: Second"), "Second", "body"],
    [
      "quoted and escaped",
      topic("body", "name: \"Quoted: name\"\ndescription: 'it''s'"),
      "Quoted: name",
      "body",
    ],
    [
      "folded multi-line description",
      topic("body", "name: T\ndescription: >\n  one\n  two"),
      "T",
      "body",
    ],
    ["multi-line name becomes one line", topic("body", 'name: "a\\nb"'), "a b", "body"],
    ["CRLF", "---\r\nname: T\r\n---\r\nbody\r\nmore", "T", "body\nmore"],
    ["BOM", "\uFEFF---\nname: T\n---\nbody", "T", "body"],
    ["leading blank lines", "\n\n---\nname: T\n---\nbody", "T", "body"],
    ["extra --- inside the body", "---\nname: T\n---\nabove\n---\nbelow", "T", "above\n---\nbelow"],
    ["empty frontmatter", "---\n---\nbody", "bad", "body"],
    ["unclosed frontmatter is body", "---\nname: T\nbody", "bad", "---\nname: T\nbody"],
    [
      "broken YAML falls back to lines",
      "---\nname: Real name\ndescription: [unclosed\n---\nbody",
      "Real name",
      "body",
    ],
    [
      "broken YAML nested metadata",
      "---\nname: T\nmetadata:\n  type: user\n  bad: [x\n---\nbody",
      "T",
      "body",
    ],
    ["title key", topic("body", "title: From title"), "From title", "body"],
    [
      "over-long name is clamped",
      topic("body", `name: ${"x".repeat(300)}`),
      "x".repeat(256),
      "body",
    ],
    ["unicode NFC", topic("body", "name: Cafe\u0301"), "Caf\u00e9", "body"],
  ];
  fixtureTest("tolerates frontmatter and layout variations, never rejecting the body", (snapshot) =>
    Effect.gen(function* () {
      for (const [label, text, title, body] of tolerated) {
        const item = candidate(yield* parseClaudeMemory(files(snapshot, [["bad.md", text]])));
        assert.equal(item.title, title, label);
        assert.equal(item.payload.text, body, label);
      }
    }),
  );

  fixtureTest("file names: dots, spaces, unicode and upper-case extension", (snapshot) =>
    Effect.gen(function* () {
      const rows = yield* parseClaudeMemory(
        files(snapshot, [
          ["a.b.md", "one"],
          ["with space.md", "two"],
          ["caf\u00e9.MD", "three"],
        ]),
      );
      assert.deepEqual(
        rows.map((row) => (row.kind === "candidate" ? row.candidate.title : "x")),
        ["a.b", "with space", "caf\u00e9"],
      );
    }),
  );

  // Every file that is not a memory is reported with a reason; the others still import.
  const skipped: readonly (readonly [string, string, string, M.MemoryImportIssue])[] = [
    ["MEMORY.md", "- [a](a.md)", "index", "index_file"],
    ["memory.md", "- [a](a.md)", "index", "index_file"],
    ["CLAUDE.md", "rules", "index", "index_file"],
    ["memory_summary.md", "x", "index", "index_file"],
    ["raw_memories.md", "x", "index", "index_file"],
    ["bad.md", "", "empty", "empty_file"],
    ["bad.md", "   \n\n", "blank", "empty_file"],
    ["bad.md", "---\nname: T\n---\n\n", "header only", "empty_file"],
    ["bad.md", "bad\ud800", "lone surrogate", "invalid_utf8"],
    ["bad.md", "bad\0", "NUL", "unsupported_format"],
    ["bad.md", "x".repeat(256 * 1024 + 1), "too large", "limit_exceeded"],
    ["bad.md", topic("sk-" + "a".repeat(24)), "secret in body", "secret_detected"],
    [
      "bad.md",
      topic("body", "name: T\ndescription: sk-" + "a".repeat(24)),
      "secret in header",
      "secret_detected",
    ],
    ["bad.md", topic("가".repeat(5461) + "xy"), "body over the payload limit", "limit_exceeded"],
  ];
  fixtureTest(
    "reports each skipped file with its reason and still imports the others",
    (snapshot) =>
      Effect.gen(function* () {
        for (const [selector, text, label, issue] of skipped) {
          const rows = yield* parseClaudeMemory(
            files(snapshot, [
              ["a-good.md", topic()],
              [selector, text],
              ["z-good.md", topic("Second.")],
            ]),
          );
          const row = rows.find((r) => r.kind === "rejected");
          assert.deepEqual(
            row && {
              key: row.kind === "rejected" ? row.sourceItemKey : "",
              issue: row.kind === "rejected" ? row.issue : "",
            },
            { key: `${selector}#body`, issue },
            label,
          );
          assert.deepEqual(
            rows.flatMap((r) => (r.kind === "candidate" ? [r.candidate.sourceItemKey] : [])),
            ["a-good.md#body", "z-good.md#body"],
            label,
          );
          assert.notInclude(JSON.stringify(rows), "sk-aaaa", label);
        }
      }),
  );

  fixtureTest("a file the reader skipped is reported, not dropped", (snapshot) =>
    Effect.gen(function* () {
      const rows = yield* parseClaudeMemory({
        ...snapshot,
        files: [
          { selector: "a.md", text: "", byteCount: 0, skip: "secret_detected" },
          { selector: "b.md", text: topic(), byteCount: topic().length },
        ],
      });
      assert.deepEqual(
        rows.map((r) => (r.kind === "rejected" ? r.issue : r.candidate.sourceItemKey)),
        ["secret_detected", "b.md#body"],
      );
    }),
  );

  fixtureTest("a secret locator still fails the whole snapshot", (snapshot) =>
    expectIssue({ ...snapshot, sourceLocator: "sk-" + "a".repeat(24) }, "secret_detected"),
  );

  fixtureTest("rejects unsafe/ambiguous selectors before emitting any row", (snapshot) =>
    Effect.gen(function* () {
      for (const selector of [
        "../bad.md",
        "/bad.md",
        "a/../bad.md",
        "a//bad.md",
        "./bad.md",
        "a\\bad.md",
        "bad\0.md",
        "C:bad.md",
        "bad.md#body",
        " bad.md",
      ]) {
        yield* expectIssue(
          files(snapshot, [
            ["good.md", topic()],
            [selector, topic()],
          ]),
          "path_rejected",
        );
      }
      yield* expectIssue(
        files(snapshot, [
          ["same.md", topic()],
          ["same.md", topic()],
        ]),
        "path_rejected",
      );
    }),
  );

  fixtureTest("defends declared bytes, profile and format", (snapshot) =>
    Effect.gen(function* () {
      const input = files(snapshot, [["topic.md", topic()]]);
      yield* expectIssue(
        snapshotMemoryImportFiles(
          input,
          input.files.map((file) => ({ ...file, byteCount: file.byteCount + 1 })),
        ),
        "source_changed",
      );
      assert.equal(
        candidate(
          yield* parseClaudeMemory(files(snapshot, [["valid.md", topic("Valid \ufffd glyph.")]])),
        ).payload.text,
        "Valid \ufffd glyph.",
      );
      yield* expectIssue({ ...snapshot, profile: "unknown" }, "unsupported_format");
      yield* expectIssue({ ...snapshot, format: "codex" }, "unsupported_format");
    }),
  );

  fixtureTest("body and key boundaries", (snapshot) =>
    Effect.gen(function* () {
      const rows = yield* parseClaudeMemory(
        files(snapshot, [["topic.md", topic("가".repeat(5461) + "x")]]),
      );
      assert.equal(candidate(rows).byteCount, M.MEMORY_BODY_MAX_UTF8_BYTES);
      candidate(yield* parseClaudeMemory(files(snapshot, [["x".repeat(504) + ".md", topic()]])));
      yield* expectIssue(files(snapshot, [["x".repeat(505) + ".md", topic()]]), "limit_exceeded");
      const entries = Array.from({ length: 128 }, (_, n) => [`topic-${n}.md`, topic()] as const);
      assert.equal((yield* parseClaudeMemory(files(snapshot, entries))).length, 128);
      yield* expectIssue(files(snapshot, [...entries, ["another.md", topic()]]), "limit_exceeded");
    }),
  );
});
