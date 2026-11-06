import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useComposerDraftStore } from "../composerDraftStore";
import { appendToComposerDraft, appendToDraftPrompt } from "./sideChatPane";

describe("appendToDraftPrompt", () => {
  it.each([
    ["", "answer", "answer"],
    ["  \n", "answer", "answer"],
    ["my question", "answer", "my question\n\nanswer"],
    ["my question\n\n", "answer", "my question\n\nanswer"],
  ])("appends to %j", (prompt, text, expected) => {
    expect(appendToDraftPrompt(prompt, text)).toBe(expected);
  });
});

it("appends to the parent's stored draft without wiping it", () => {
  const ref = scopeThreadRef(EnvironmentId.make("environment-local"), ThreadId.make("parent"));
  const store = useComposerDraftStore.getState();
  appendToComposerDraft(ref, "first");
  store.setPrompt(ref, "typed");
  appendToComposerDraft(ref, "second");
  expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toBe("typed\n\nsecond");
  store.clearComposerContent(ref);
});
