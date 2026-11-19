import { describe, expect, it } from "vite-plus/test";
import { draftHasUserContent } from "./composerDraft.ts";

describe("draftHasUserContent", () => {
  it.each([
    ["only whitespace", { prompt: " \n\t ", attachmentCount: 0, contextCount: 0 }, false],
    ["text", { prompt: "half a thought", attachmentCount: 0, contextCount: 0 }, true],
    ["only an attachment", { prompt: "", attachmentCount: 1, contextCount: 0 }, true],
    ["only a context", { prompt: "", attachmentCount: 0, contextCount: 1 }, true],
    // A draft that holds only a model or mode pick reaches here with nothing counted.
    ["only a model or mode", { prompt: "", attachmentCount: 0, contextCount: 0 }, false],
  ])("%s", (_case, draft, expected) => {
    expect(draftHasUserContent(draft)).toBe(expected);
  });
});
