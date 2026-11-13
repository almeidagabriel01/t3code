import { describe, expect, it } from "vite-plus/test";

import { channelStrings } from "../channelStrings.ts";
import {
  formatTelegramMessages,
  TELEGRAM_MAX_PARTS,
  TELEGRAM_MESSAGE_LIMIT,
  type TelegramMessageInput,
  type TelegramText,
} from "./telegramText.ts";

const HOSTED = "https://app.t3.codes";
const WEB_THREAD = `${HOSTED}/threads/env-1/thread-1`;
const strings = channelStrings("en");

const one = (text: string, input: Partial<TelegramMessageInput> = {}) => {
  const pieces = formatTelegramMessages(
    { text, markdown: true, ...input },
    { hostedAppUrl: HOSTED },
  );
  expect(pieces).toHaveLength(1);
  return pieces[0]!.html;
};

/** Every tag a piece opens is closed in order, as Telegram's parser requires. */
const balanced = (html: string) => {
  const stack: Array<string> = [];
  for (const [, closing, name] of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (closing === "") stack.push(name!);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
};
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const expectSendable = (pieces: ReadonlyArray<TelegramText>) => {
  for (const { html, plain } of pieces) {
    expect(html.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(plain.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(balanced(html)).toBe(true);
    expect(LONE_SURROGATE.test(html)).toBe(false);
    expect(html).not.toContain("t3-thread://");
  }
};

const conversions: ReadonlyArray<readonly [string, string, string]> = [
  ["plain sentence", "Done, all tests pass.", "Done, all tests pass."],
  [
    "thread link is its title in bold, linked to the web",
    "See [Fix login](t3-thread://v2/env-1/thread-1).",
    `See <b><a href="${WEB_THREAD}">Fix login</a></b>.`,
  ],
  [
    "hosted thread link is treated the same",
    `See [Fix login](${WEB_THREAD}).`,
    `See <b><a href="${WEB_THREAD}">Fix login</a></b>.`,
  ],
  [
    "untitled thread link",
    "See <t3-thread://v2/env-1/thread-1>",
    `See <b><a href="${WEB_THREAD}">Thread</a></b>`,
  ],
  [
    "v1 thread link has no web link",
    "See [Fix login](t3-thread://v1/thread-1)",
    "See <b>Fix login</b>",
  ],
  [
    "thread link inside code stays as written",
    "`[x](t3-thread://v2/env-1/thread-1)`",
    "<code>[x](t3-thread://v2/env-1/thread-1)</code>",
  ],
  [
    "web link keeps its address, escaped",
    "[docs](https://x.dev/a?b=1&c=2)",
    '<a href="https://x.dev/a?b=1&amp;c=2">docs</a>',
  ],
  [
    "bare web link",
    "go to https://x.dev now",
    'go to <a href="https://x.dev">https://x.dev</a> now',
  ],
  ["javascript link is only its label", "[run](javascript:alert(1))", "run"],
  ["mailto link shows its address as text", "[mail](mailto:a@b.dev)", "mail (a@b.dev)"],
  ["file link is only its label", "[notes](file:///etc/passwd)", "notes"],
  ["bold is never nested in bold", "# **hi** there", "<b>hi there</b>"],
  [
    "thread link in a heading",
    "## See [Fix](t3-thread://v2/env-1/thread-1)",
    `<b>See <a href="${WEB_THREAD}">Fix</a></b>`,
  ],
  ["nested quote joins its parent", "> a\n>\n> > b", "<blockquote>a\nb</blockquote>"],
  [
    "code in a quote is set apart",
    "> look\n>\n> ```\n> x\n> ```",
    "<blockquote>look</blockquote>\n<pre>x</pre>",
  ],
  ["escapes text", "a < b && c > d", "a &lt; b &amp;&amp; c &gt; d"],
  ["raw html is text", "<div>x</div> <b>y</b>", "&lt;div&gt;x&lt;/div&gt; &lt;b&gt;y&lt;/b&gt;"],
  ["inline code", "run `a<b> && *c*`", "run <code>a&lt;b&gt; &amp;&amp; *c*</code>"],
  [
    "code block with language",
    "```ts\nconst a = 1 < 2 && _b_;\n```",
    '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; _b_;</code></pre>',
  ],
  ["code block without language", "```\n<x>\n```", "<pre>&lt;x&gt;</pre>"],
  ["emphasis", "**bold** *it* ~~gone~~", "<b>bold</b> <i>it</i> <s>gone</s>"],
  ["heading", "## Plan\nnext", "<b>Plan</b>\n\nnext"],
  ["bullets", "- one\n- two\n  - nested", "• one\n• two\n    • nested"],
  ["ordered list keeps its numbers", "3. three\n4. four", "3. three\n4. four"],
  ["task list", "- [x] done\n- [ ] todo", "• ☑ done\n• ☐ todo"],
  [
    "table becomes a list",
    "| Name | Role | Status |\n| --- | --- | --- |\n| Jarvis | lead | **on** |\n| Ana | qa |  |",
    "• <b>Jarvis</b> · Role: lead · Status: <b>on</b>\n• <b>Ana</b> · Role: qa",
  ],
  ["quote", "> careful", "<blockquote>careful</blockquote>"],
];

describe("formatTelegramMessages conversion", () => {
  it.each(conversions)("%s", (_name, input, expected) => {
    expect(one(input)).toBe(expected);
  });

  it("drops the web link when no origin is known", () => {
    const [piece] = formatTelegramMessages({
      text: "[Fix login](t3-thread://v2/env-1/thread-1)",
      markdown: true,
    });
    expect(piece!.html).toBe("<b>Fix login</b>");
  });

  it("never sends an empty message", () => {
    expect(formatTelegramMessages({ text: "", senderName: "Bot" })).toEqual([]);
    expect(formatTelegramMessages({ text: "[x]: https://a.dev", markdown: true })).toEqual([
      { html: "[x]: https://a.dev", plain: "[x]: https://a.dev" },
    ]);
  });

  it("leaves a short message's content unchanged, after the speaker's name", () => {
    expect(formatTelegramMessages({ text: "hello there", senderName: "Jarvis" })).toEqual([
      { html: "<b>Jarvis:</b> hello there", plain: "Jarvis: hello there" },
    ]);
  });

  it("never reads T3's own phrases or names as markup", () => {
    expect(one("Title *x* <y> & [a](b)", { markdown: false, senderName: "a_b*<c>" })).toBe(
      "<b>a_b*&lt;c&gt;:</b> Title *x* &lt;y&gt; &amp; [a](b)",
    );
  });

  it("ends with the numbered choices, escaped", () => {
    expect(
      one("**Run it?**", {
        choices: [
          { label: "Yes <now>", value: "y" },
          { label: "No", value: "n" },
        ],
      }),
    ).toBe("<b>Run it?</b>\n\n1. Yes &lt;now&gt;\n2. No\nReply with the number.");
  });

  it("gives a plain copy with links written out", () => {
    const [piece] = formatTelegramMessages(
      { text: "**a** < [docs](https://x.dev) [T](t3-thread://v2/env-1/thread-1)", markdown: true },
      { hostedAppUrl: HOSTED },
    );
    expect(piece!.plain).toBe(`a < docs (https://x.dev) T (${WEB_THREAD})`);
  });
});

const paragraphs = (count: number, size: number) =>
  Array.from({ length: count }, (_, i) => `Paragraph ${i}. ${"word ".repeat(size)}`.trim());

describe("formatTelegramMessages size", () => {
  it("splits a long reply into numbered parts at block boundaries", () => {
    const text = paragraphs(6, 250).join("\n\n");
    const pieces = formatTelegramMessages({ text, markdown: true, senderName: "Jarvis" });
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.length).toBeLessThanOrEqual(TELEGRAM_MAX_PARTS);
    expectSendable(pieces);
    pieces.forEach((piece, index) =>
      expect(piece.html.startsWith(`<b>Jarvis:</b> (${index + 1}/${pieces.length}) `)).toBe(true),
    );
    const sent = pieces.map((piece) => piece.plain).join("\n");
    for (const paragraph of paragraphs(6, 250)) expect(sent).toContain(paragraph);
  });

  it("splits a code block by lines, reopening it in every part", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `const v${i} = a < b && c;`);
    const pieces = formatTelegramMessages({
      text: `Intro.\n\n\`\`\`ts\n${lines.join("\n")}\n\`\`\``,
      markdown: true,
    });
    expect(pieces.length).toBeGreaterThan(1);
    expectSendable(pieces);
    const code = pieces
      .flatMap((piece) => [...piece.plain.matchAll(/const v\d+ = a < b && c;/g)].map((m) => m[0]))
      .join("\n");
    expect(code).toBe(lines.join("\n"));
  });

  it("cuts a single overlong word without splitting an emoji", () => {
    const pieces = formatTelegramMessages({ text: "😀".repeat(3000), senderName: "Jarvis" });
    expect(pieces.length).toBeGreaterThan(1);
    expectSendable(pieces);
    expect(pieces.map((piece) => piece.plain.replace(/^Jarvis: \(\d\/\d\) /, "")).join("")).toBe(
      "😀".repeat(3000),
    );
  });

  it("ends a reply too long for its parts with the note", () => {
    const pieces = formatTelegramMessages({
      text: paragraphs(40, 200).join("\n\n"),
      markdown: true,
    });
    expect(pieces).toHaveLength(TELEGRAM_MAX_PARTS);
    expectSendable(pieces);
    expect(pieces.at(-1)!.plain.endsWith(strings.truncatedNote)).toBe(true);
  });

  it.each([
    ["a heading that names it", "## Esperando você\n\nPosso fazer o merge da branch agora?"],
    ["a closing question and its options", "Which one should I ship?\n\n- the fix\n- the refactor"],
  ])("sends the part that waits on you whole after an outline: %s", (_name, waiting) => {
    const text = `# Report\n\n${paragraphs(12, 120).join("\n\n")}\n\n\`\`\`sh\nls\n\`\`\`\n\n${waiting}`;
    const pieces = formatTelegramMessages({ text, markdown: true, senderName: "Jarvis" });
    expect(pieces).toHaveLength(1);
    expectSendable(pieces);
    const [piece] = pieces;
    expect(piece!.html).toContain("<b>Report</b>\nParagraph 0.");
    expect(piece!.html).toContain(strings.codeSummary(1));
    expect(piece!.html).toContain(strings.summaryNote);
    expect(piece!.plain.endsWith(waiting.replace("## ", "").replace(/^- /gm, "• "))).toBe(true);
  });

  it("keeps emoji whole in the outline", () => {
    const text = `# ${"😀".repeat(300)}\n\n${paragraphs(12, 120).join("\n\n")}\n\n## Esperando você\n\nPosso seguir?`;
    const pieces = formatTelegramMessages({ text, markdown: true });
    expect(pieces).toHaveLength(1);
    expectSendable(pieces);
  });

  it("does not treat a heading that reports decisions as waiting on you", () => {
    const text = `${paragraphs(12, 120).join("\n\n")}\n\n## Decisões tomadas\n\nUsei HTML.`;
    const pieces = formatTelegramMessages({ text, markdown: true });
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[0]!.plain).not.toContain(strings.summaryNote);
  });

  it("keeps a split table one row per line", () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| row ${i} | ${"v".repeat(20)} |`);
    const pieces = formatTelegramMessages({
      text: `| Name | Value |\n| --- | --- |\n${rows.join("\n")}`,
      markdown: true,
    });
    expect(pieces.length).toBeGreaterThan(1);
    expectSendable(pieces);
    expect(pieces[0]!.html).not.toContain("\n\n");
  });

  it("keeps the choices whole after an outline of a long decision", () => {
    const pieces = formatTelegramMessages({
      text: paragraphs(12, 120).join("\n\n"),
      choices: [
        { label: "Approve", value: "a" },
        { label: "Deny", value: "d" },
      ],
    });
    expect(pieces).toHaveLength(1);
    expectSendable(pieces);
    expect(pieces[0]!.plain.endsWith("1. Approve\n2. Deny\nReply with the number.")).toBe(true);
  });

  it("gives the same pieces every time", () => {
    const input = { text: paragraphs(10, 200).join("\n\n"), markdown: true, senderName: "J" };
    expect(formatTelegramMessages(input)).toEqual(formatTelegramMessages(input));
  });
});
