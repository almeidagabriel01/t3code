import * as M from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { firstField, readFrontmatter } from "./MemoryFrontmatter.ts";
import {
  bytes,
  canonical,
  fileProblem,
  hash,
  rejectedRow,
  safeSelector,
  secret,
  titleOf,
} from "./MemoryImportParseSupport.ts";
import type { ImportParsedItem, MemoryImportParser } from "./MemoryImportTypes.ts";

const isPayload = Schema.is(M.MemoryPayload);
const INDEX_FILE = /^(?:memory|claude|index|readme|memory_summary|raw_memories)\.md$/iu;

/** Name from frontmatter, else the first heading, else the file name. */
const nameOf = (fm: ReturnType<typeof readFrontmatter>, selector: string) =>
  titleOf(
    firstField(fm, "name", "title") ??
      /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/mu.exec(fm.body)?.[1] ??
      selector.replace(/\.md$/iu, ""),
  ) || "Untitled";

/** Pure snapshot -> one row per file. A file that cannot be imported becomes a rejected row. */
export const parseClaudeMemory: MemoryImportParser = Effect.fn("parseClaudeMemory")(
  function* (input) {
    const fail = (issue: M.MemoryImportIssue) => Effect.fail(new M.MemoryImportRpcError({ issue }));
    if (
      input.format !== "claude" ||
      input.slot.format !== "claude" ||
      !["claude-topic-v1", "claude-topic-metadata-v1"].includes(input.profile)
    )
      return yield* fail("unsupported_format");
    if (secret(input.sourceLocator)) return yield* fail("secret_detected");
    const seen = new Set<string>();
    let totalBytes = 0;
    // Snapshot-level invariants only; anything wrong with a single file is a row below.
    for (const file of input.files) {
      if (!safeSelector(file.selector) || seen.has(file.selector))
        return yield* fail("path_rejected");
      seen.add(file.selector);
      if (secret(file.selector)) return yield* fail("secret_detected");
      const actual = bytes(file.text);
      totalBytes += actual;
      if (totalBytes > M.MEMORY_IMPORT_SNAPSHOT_MAX_UTF8_BYTES)
        return yield* fail("limit_exceeded");
      if (actual !== file.byteCount) return yield* fail("source_changed");
    }
    const rows: ImportParsedItem[] = [];
    for (const file of input.files) {
      if (file.selector.includes("/") || !/\.md$/iu.test(file.selector)) continue;
      const key = `${file.selector}#body`;
      if (bytes(key) > M.MEMORY_IMPORT_KEY_MAX_UTF8_BYTES) return yield* fail("limit_exceeded");
      const reject = (issue: M.MemoryImportIssue) =>
        rows.push(rejectedRow(key, file.byteCount, issue));
      const problem = fileProblem(file);
      if (problem) {
        reject(problem);
        continue;
      }
      if (INDEX_FILE.test(file.selector)) {
        reject("index_file");
        continue;
      }
      const fm = readFrontmatter(file.text);
      const body = canonical(fm.body);
      if (!body) {
        reject("empty_file");
        continue;
      }
      const name = nameOf(fm, file.selector);
      const description = canonical(firstField(fm, "description") ?? "");
      const type = canonical(firstField(fm, "metadata.type", "type") ?? "reference");
      if (secret(`${name}\n${description}\n${body}`)) {
        reject("secret_detected");
        continue;
      }
      const payload = { text: body, evidence: [], derivedFromMemoryRevisions: [] };
      if (!name || !isPayload(payload)) {
        reject("limit_exceeded");
        continue;
      }
      rows.push({
        kind: "candidate",
        candidate: {
          sourceItemKey: key,
          sourceFingerprint: hash(
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- deterministic tuple framing for hashing, not a JSON wire codec.
            JSON.stringify([input.parserVersion, name, description, type, body]),
          ),
          contentFingerprint: hash(body),
          title: name,
          payload,
          byteCount: bytes(body),
        },
      });
    }
    if (rows.length > M.MEMORY_IMPORT_PREVIEW_MAX_ITEMS) return yield* fail("limit_exceeded");
    return rows;
  },
);
