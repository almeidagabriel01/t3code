import { describe, expect, it } from "vite-plus/test";

import { channelStrings } from "../channelStrings.ts";
import {
  chunkParagraphs,
  formatImessageMessages,
  IMESSAGE_CHUNK_LIMIT,
  IMESSAGE_MAX_MESSAGES,
  toPlainText,
} from "./imessageText.ts";

const TRUNCATED_NOTE = channelStrings("en").truncatedNote;

const plain: ReadonlyArray<readonly [string, string, string]> = [
  ["bold", "this is **bold** and __also__", "this is bold and also"],
  ["italic", "an *emphasis* and _more_ here", "an emphasis and more here"],
  ["snake_case and math stay", "my_var_name and 2 * 3 * 4", "my_var_name and 2 * 3 * 4"],
  ["strike", "~~gone~~", "gone"],
  ["heading", "## Title\ntext", "Title\ntext"],
  ["bullets", "* one\n+ two\n- three", "- one\n- two\n- three"],
  ["link", "see [docs](https://a.dev/x)", "see docs (https://a.dev/x)"],
  ["bare link", "[https://a.dev](https://a.dev)", "https://a.dev"],
  ["inline code", "run `ls -la` now", "run ls -la now"],
  [
    "fenced code keeps its lines",
    "before\n```ts\nconst a = 1;\n```\nafter",
    "before\n\nconst a = 1;\n\nafter",
  ],
  ["blank lines collapse", "a\n\n\n\nb", "a\n\nb"],
  [
    "thread link opens on the web",
    "see [Fix login](t3-thread://v2/env-1/thread-1)",
    "see Fix login (https://app.t3.codes/threads/env-1/thread-1)",
  ],
  ["v1 thread link is its title", "see [Fix login](t3-thread://v1/thread-1)", "see Fix login"],
  [
    "untitled thread link is its web link",
    "see <t3-thread://v2/env-1/thread-1>",
    "see https://app.t3.codes/threads/env-1/thread-1",
  ],
  [
    "thread link in code stays",
    "`[x](t3-thread://v2/env-1/thread-1)`",
    "[x](t3-thread://v2/env-1/thread-1)",
  ],
];

describe("toPlainText", () => {
  it.each(plain)("%s", (_name, input, expected) => {
    expect(toPlainText(input)).toBe(expected);
  });
});

describe("chunkParagraphs", () => {
  it("packs paragraphs and splits only between them when it can", () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(40));
    const chunks = chunkParagraphs(paragraphs.join("\n\n"), 100);
    expect(chunks).toEqual([
      `${paragraphs[0]}\n\n${paragraphs[1]}`,
      `${paragraphs[2]}\n\n${paragraphs[3]}`,
      `${paragraphs[4]}\n\n${paragraphs[5]}`,
    ]);
  });

  it("splits a long paragraph at a newline, then a space, then anywhere, never inside an emoji", () => {
    expect(chunkParagraphs("aaa\nbbb\nccc", 8)).toEqual(["aaa\nbbb", "ccc"]);
    expect(chunkParagraphs("aaaa bbbb cccc", 9)).toEqual(["aaaa bbbb", "cccc"]);
    expect(chunkParagraphs("x".repeat(25), 10)).toEqual([
      "x".repeat(10),
      "x".repeat(10),
      "x".repeat(5),
    ]);
    for (const chunk of chunkParagraphs("🐐".repeat(20), 7)) {
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });
});

describe("formatImessageMessages", () => {
  it("names the speaker on every message", () => {
    const text = Array.from({ length: 3 }, () => "y".repeat(IMESSAGE_CHUNK_LIMIT - 10)).join(
      "\n\n",
    );
    const messages = formatImessageMessages({ senderName: "Jarvis", text });
    expect(messages).toHaveLength(3);
    for (const message of messages) expect(message.startsWith("Jarvis: ")).toBe(true);
  });

  it("keeps a short reply as one plain message", () => {
    expect(formatImessageMessages({ senderName: "Jarvis", text: "**Done**" })).toEqual([
      "Jarvis: Done",
    ]);
  });

  it("caps a long reply with a note", () => {
    const text = Array.from({ length: 20 }, () => "z".repeat(IMESSAGE_CHUNK_LIMIT - 10)).join(
      "\n\n",
    );
    const messages = formatImessageMessages({ senderName: "Jarvis", text });
    expect(messages).toHaveLength(IMESSAGE_MAX_MESSAGES);
    expect(messages.at(-1)).toBe(`Jarvis: ${TRUNCATED_NOTE}`);
  });

  it("ends a card with its options as a numbered list, whatever the length", () => {
    const choices = [
      { label: "Approve", value: "a" },
      { label: "Deny", value: "d" },
    ];
    expect(formatImessageMessages({ senderName: "Jarvis", text: "Deploy?", choices })).toEqual([
      "Jarvis: Deploy?\n\n1. Approve\n2. Deny\nReply with the number.",
    ]);
    const long = Array.from({ length: 20 }, () => "z".repeat(IMESSAGE_CHUNK_LIMIT - 10)).join(
      "\n\n",
    );
    const messages = formatImessageMessages({ senderName: "Jarvis", text: long, choices });
    expect(messages).toHaveLength(IMESSAGE_MAX_MESSAGES - 1);
    expect(messages.at(-1)).toBe(
      `Jarvis: ${TRUNCATED_NOTE}\n\n1. Approve\n2. Deny\nReply with the number.`,
    );
    const full = formatImessageMessages({
      senderName: "Jarvis",
      text: "z".repeat(IMESSAGE_CHUNK_LIMIT),
      choices,
    });
    expect(full).toHaveLength(2);
    expect(full[1]).toBe("Jarvis: 1. Approve\n2. Deny\nReply with the number.");
  });

  it("words the hint and the truncation note in the message's language", () => {
    const choices = [{ label: "Aprovar", value: "a" }];
    expect(
      formatImessageMessages({
        senderName: "Jarvis",
        text: "Publicar?",
        choices,
        language: "pt-BR",
      }),
    ).toEqual(["Jarvis: Publicar?\n\n1. Aprovar\nResponda com o número."]);
    const long = Array.from({ length: 20 }, () => "z".repeat(IMESSAGE_CHUNK_LIMIT - 10)).join(
      "\n\n",
    );
    const messages = formatImessageMessages({
      senderName: "Jarvis",
      text: long,
      language: "pt-BR",
    });
    expect(messages.at(-1)).toBe(`Jarvis: ${channelStrings("pt-BR").truncatedNote}`);
  });
});
