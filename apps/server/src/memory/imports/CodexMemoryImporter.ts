import * as M from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  bytes,
  canonical,
  control,
  fileProblem,
  hash,
  rejectedRow,
  safeSelector,
  secret,
  titleOf,
} from "./MemoryImportParseSupport.ts";
import type { ImportParsedItem, MemoryImportParser } from "./MemoryImportTypes.ts";

// Fingerprints are keyed by item kind, not by the slot profile, so a note keeps its identity
// when a handbook appears next to it.
const HANDBOOK_VERSION = "codex-handbook-v1";
const NOTE_VERSION = "codex-ad-hoc-v1";
const noteSelector = (s: string) => /^extensions\/ad_hoc\/notes\/[^/]+\.md$/u.test(s);
const transcriptEnvelope = (line: string) => {
  if (!line.trimStart().startsWith("{")) return false;
  try {
    const value: unknown = JSON.parse(line);
    return (
      value !== null &&
      typeof value === "object" &&
      (("type" in value &&
        typeof value.type === "string" &&
        ("payload" in value ||
          ["session_meta", "event_msg", "response_item", "turn_context"].includes(value.type))) ||
        ("role" in value && "content" in value))
    );
  } catch {
    return false;
  }
};

type Group = { title: string; body: string[]; scope?: string; routing?: string };

/** Splits a handbook into task groups. Unknown lines before the first group are ignored. */
const handbookGroups = (text: string) => {
  const groups: Group[] = [];
  let group: Group | undefined;
  let fence: { char: string; length: number } | undefined;
  let omitSection = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (group && !omitSection) group.body.push(line);
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        marker[2]!.trim() === ""
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      if (group && !omitSection) group.body.push(line);
      continue;
    }
    const heading = /^#{1,2}[ \t]*Task Group:[ \t]*(.*?)[ \t]*$/iu.exec(line);
    if (heading) {
      group = { title: titleOf(heading[1]!) || "Untitled", body: [] };
      groups.push(group);
      omitSection = false;
      continue;
    }
    if (!group) continue;
    if (line.startsWith("scope:")) {
      group.scope = canonical(line.slice(6));
      continue;
    }
    if (line.startsWith("applies_to:")) {
      group.routing = canonical(line.slice(11));
      continue;
    }
    const section = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (section && section[1]!.length <= 3)
      omitSection = section[2] === "rollout_summary_files" || section[2] === "keywords";
    if (!omitSection) group.body.push(line);
  }
  return groups;
};

/** Handbook task groups and ad-hoc notes, by file. One bad file or group never hides the rest. */
export const parseCodexMemory: MemoryImportParser = Effect.fn("parseCodexMemory")(
  function* (input) {
    const fail = (issue: M.MemoryImportIssue) => Effect.fail(new M.MemoryImportRpcError({ issue }));
    if (
      input.format !== "codex" ||
      input.slot.format !== "codex" ||
      !["codex-handbook-v1", "codex-ad-hoc-v1"].includes(input.profile) ||
      input.parserVersion !== input.profile
    )
      return yield* fail("unsupported_format");
    if (secret(input.sourceLocator) || secret(input.parserVersion))
      return yield* fail("secret_detected");
    const items: ImportParsedItem[] = [];
    const selectors = new Set<string>();
    let totalBytes = 0;
    for (const file of input.files) {
      if (!safeSelector(file.selector)) return yield* fail("path_rejected");
      if (secret(file.selector)) return yield* fail("secret_detected");
      if (selectors.has(file.selector)) return yield* fail("path_rejected");
      selectors.add(file.selector);
      const size = bytes(file.text);
      totalBytes += size;
      if (totalBytes > M.MEMORY_IMPORT_SNAPSHOT_MAX_UTF8_BYTES)
        return yield* fail("limit_exceeded");
      if (size !== file.byteCount) return yield* fail("source_changed");
      const handbook = file.selector === "MEMORY.md";
      if (!handbook && !noteSelector(file.selector)) continue;
      const add = (
        key: string,
        body: string,
        version: string,
        title?: string,
        metadata: readonly string[] = [],
      ) => {
        if (bytes(key) > M.MEMORY_IMPORT_KEY_MAX_UTF8_BYTES) return "path_rejected" as const;
        const text = canonical(body);
        const byteCount = bytes(text);
        const payload = { text, evidence: [], derivedFromMemoryRevisions: [] };
        const issue =
          text.length === 0
            ? "empty_file"
            : secret(`${key}\n${title ?? ""}\n${text}`)
              ? "secret_detected"
              : bytes(JSON.stringify(payload)) > M.MEMORY_PAYLOAD_MAX_UTF8_BYTES ||
                  byteCount > M.MEMORY_BODY_MAX_UTF8_BYTES
                ? "limit_exceeded"
                : undefined;
        if (issue) items.push(rejectedRow(key, byteCount, issue));
        else
          items.push({
            kind: "candidate",
            candidate: {
              sourceItemKey: key,
              sourceFingerprint: hash(JSON.stringify([version, title ?? null, text, metadata])),
              contentFingerprint: hash(text),
              ...(title === undefined ? {} : { title }),
              payload,
              byteCount,
            },
          });
        return undefined;
      };
      const problem = fileProblem(file);
      if (problem) {
        items.push(rejectedRow(handbook ? file.selector : `${file.selector}#body`, 0, problem));
      } else if (!handbook) {
        if (file.selector.endsWith("/instructions.md"))
          items.push(rejectedRow(`${file.selector}#body`, size, "index_file"));
        // JSON/JSONL transcript envelopes are never Markdown-note fallback inputs.
        else if (file.text.split(/\r?\n/u).some(transcriptEnvelope))
          items.push(rejectedRow(`${file.selector}#body`, size, "unsupported_format"));
        else {
          const failed = add(`${file.selector}#body`, file.text, NOTE_VERSION);
          if (failed) return yield* fail(failed);
        }
      } else {
        const groups = handbookGroups(file.text);
        if (groups.length === 0) items.push(rejectedRow(file.selector, size, "unsupported_format"));
        const used = new Set<string>();
        for (const group of groups) {
          let title = group.title;
          for (let n = 2; used.has(title); n++) title = `${group.title} (${n})`;
          used.add(title);
          const key = `MEMORY.md#task-group:${title}`;
          add(
            bytes(key) > M.MEMORY_IMPORT_KEY_MAX_UTF8_BYTES || control(key)
              ? `MEMORY.md#task-group:${hash(title).slice(0, 32)}`
              : key,
            group.body.join("\n"),
            HANDBOOK_VERSION,
            title,
            [group.scope ?? "", group.routing ?? ""],
          );
        }
      }
      if (items.length > M.MEMORY_IMPORT_PREVIEW_MAX_ITEMS) return yield* fail("limit_exceeded");
    }
    return items;
  },
);
