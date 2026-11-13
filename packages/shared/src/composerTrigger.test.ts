import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  isAtMessageStart,
  parseSideChatCommand,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
  ])("keeps the path in %j out of the slash menu", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it("opens the model picker after the chips attaching put first", () => {
    const text = `${FILE_CHIP} /model op`;
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-model",
      query: "op",
      rangeStart: FILE_CHIP.length + 1,
      rangeEnd: text.length,
    });
  });

  it("keeps a slash in the line-leading model picker query", () => {
    expect(detectComposerTrigger("/model openai/gpt", 17)).toMatchObject({
      kind: "slash-model",
      query: "openai/gpt",
    });
  });

  it.each(["/Model opus", "/MODEL opus"])(
    "opens the model picker for capitalized %j the same as /model",
    (text) => {
      expect(detectComposerTrigger(text, text.length)).toMatchObject({
        kind: "slash-model",
        query: "opus",
      });
    },
  );

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "€", "𑿝"])("detects %s skill prefixes and their source range", (prefix) => {
    const text = `Use ${prefix}review`;
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "skill",
      query: "review",
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each([
    "budget $9.99",
    "only $.99",
    "about €20",
    "raise $10k",
    "$1,000",
    "£2e6",
    "raise $10k.",
  ])("does not open the skill menu for the amount in %j", (text) =>
    expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "$1password", "$2fa"])("still detects the skill prefix %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toMatchObject({
      kind: "skill",
      query: text.slice(1),
    });
  });
});

describe("serializeComposerFileLink", () => {
  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

const FILE_CHIP = "[note.txt](t3-context://v1/file/file_a1)";
const IMAGE_CHIP = "![shot.png](t3-context://v1/image/image_b2)";
const THREAD_CHIP = "[Fix login](t3-context://v1/thread/thread_c3)";

describe("parseSideChatCommand", () => {
  it.each([
    [
      "a chip before the command",
      `${FILE_CHIP} /side What is in it?`,
      `${FILE_CHIP} What is in it?`,
    ],
    [
      "several chips before the command",
      `${FILE_CHIP} ${IMAGE_CHIP}\n /btw  Compare them`,
      `${FILE_CHIP} ${IMAGE_CHIP} Compare them`,
    ],
    ["chips and no question", `${IMAGE_CHIP} /side`, IMAGE_CHIP],
    [
      "a chip after the command",
      `/side What is in it? ${FILE_CHIP}`,
      `What is in it? ${FILE_CHIP}`,
    ],
    [
      "a non-attachment chip, which the send then blocks",
      `${THREAD_CHIP} /side Why?`,
      `${THREAD_CHIP} Why?`,
    ],
  ])("reads %s", (_case, text, prompt) => {
    expect(parseSideChatCommand(text)).toEqual({ prompt });
  });

  it.each([
    ["text before the command", "ask /side later"],
    ["text between chip and command", `${FILE_CHIP} ask /side later`],
    ["a longer word after a chip", `${FILE_CHIP} /sidebar`],
    ["a file mention, which is typed text", "[a.ts](src/a.ts) /side Why?"],
  ])("leaves %s as plain text", (_case, text) => {
    expect(parseSideChatCommand(text)).toBeNull();
  });

  it("reads an optional prompt after /side or /btw", () => {
    expect(parseSideChatCommand("/side")).toEqual({ prompt: "" });
    expect(parseSideChatCommand("  /SIDE  why does this fail?\nline two ")).toEqual({
      prompt: "why does this fail?\nline two",
    });
    expect(parseSideChatCommand("/btw check @src/a.ts")).toEqual({ prompt: "check @src/a.ts" });
  });

  it("ignores other commands and inline mentions", () => {
    expect(parseSideChatCommand("/sidebar")).toBeNull();
    expect(parseSideChatCommand("/btwx")).toBeNull();
    expect(parseSideChatCommand("ask /side later")).toBeNull();
  });
});

describe("isAtMessageStart", () => {
  it.each([
    ["", 0, true],
    ["  /si", 2, true],
    [`${FILE_CHIP} /si`, FILE_CHIP.length + 1, true],
    [`${FILE_CHIP} ${IMAGE_CHIP}\n/si`, FILE_CHIP.length + IMAGE_CHIP.length + 2, true],
    ["Use /si", 4, false],
    [`${FILE_CHIP} Use /si`, FILE_CHIP.length + 5, false],
  ])("%j at %i is %s", (text, offset, expected) => {
    expect(isAtMessageStart(text, offset)).toBe(expected);
  });
});
