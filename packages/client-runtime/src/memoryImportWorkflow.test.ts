import { describe, expect, it } from "vite-plus/test";
import { memoryImportSkippedSummary, memoryImportSourceName } from "./memoryImportWorkflow.ts";

describe("memoryImportSourceName", () => {
  it.each([
    ["-Users-me-DEV-Pessoal-my-app", "DEV-Pessoal-my-app"],
    ["-Users-me", "Home folder"],
    ["-private-var-T", "private-var-T"],
    ["codex", "codex"],
  ])("reads %s as %s", (label, name) => {
    expect(memoryImportSourceName(label)).toBe(name);
  });
});

describe("memoryImportSkippedSummary", () => {
  it.each([
    [[{}, { issue: undefined }], null],
    [
      [{ issue: "index_file" }, { issue: "index_file" }, { issue: "limit_exceeded" }, {}],
      "3 skipped: 2 index files, 1 too large",
    ],
    [[{ issue: "empty_file" }, { issue: "storage_failed" }], "2 skipped: 1 empty file, 1 other"],
  ] as const)("summarizes %j", (items, expected) => {
    expect(memoryImportSkippedSummary(items)).toBe(expected);
  });
});
