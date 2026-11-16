import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import { isLongMessage } from "./messageFold.ts";

describe("isLongMessage", () => {
  it("measures a quote chip by its label, not its encoded link", () => {
    const quote = "A long assistant paragraph that the user quoted. ".repeat(40);
    const citation = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("source"),
      text: quote,
      comment: "Why does this matter?",
      start: 0,
      end: quote.length,
      prefix: "",
      suffix: "",
    });

    expect(isLongMessage(`${citation} Can you expand on this?`)).toBe(false);
    expect(isLongMessage(`${citation} ${"More text. ".repeat(60)}`)).toBe(true);
  });

  it.each([
    ["a short reply", "Done: retry added.", false],
    ["nine short lines", Array.from({ length: 9 }, () => "x").join("\n"), true],
    ["a long paragraph", "word ".repeat(130), true],
    ["blank text", "  \n ", false],
  ])("%s", (_name, text, long) => {
    expect(isLongMessage(text)).toBe(long);
  });
});
