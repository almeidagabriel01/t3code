import { describe, expect, it } from "vite-plus/test";
import { memoryImportSourceName } from "./memoryImportWorkflow.ts";

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
