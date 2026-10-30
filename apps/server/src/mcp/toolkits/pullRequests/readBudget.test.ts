import { describe, expect, it } from "@effect/vitest";

import { bytesOf, clipFields, clipJsonText, fitItems } from "./readBudget.ts";

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("clipJsonText", () => {
  // The budget counts the JSON string body: escapes and multi-byte characters included.
  it.each([
    { name: "ascii", char: "a", size: 1 },
    { name: "an escaped quote", char: '"', size: 2 },
    { name: "an escaped newline", char: "\n", size: 2 },
    { name: "two-byte", char: "é", size: 2 },
    { name: "CJK", char: "日", size: 3 },
    { name: "an emoji pair", char: "😀", size: 4 },
  ])("cuts $name text exactly at the budget, never inside a character", ({ char, size }) => {
    const text = char.repeat(10);
    const exact = clipJsonText(text, size * 10);
    expect(exact).toEqual({ text, truncated: false });

    const under = clipJsonText(text, size * 10 - 1);
    expect(under).toEqual({ text: char.repeat(9), truncated: true });
    expect(lone.test(under.text)).toBe(false);
    expect(bytesOf(under.text) - 2).toBeLessThanOrEqual(size * 10 - 1);

    // A budget that ends mid-character keeps only whole characters.
    const partial = clipJsonText(text, size * 5 + (size > 1 ? 1 : 0));
    expect(partial.text).toBe(char.repeat(5));
    expect(lone.test(partial.text)).toBe(false);
  });

  it("handles an empty text and a zero budget", () => {
    expect(clipJsonText("", 0)).toEqual({ text: "", truncated: false });
    expect(clipJsonText("abc", 0)).toEqual({ text: "", truncated: true });
  });
});

describe("fitItems", () => {
  it("keeps the leading items that fit with their separators and counts the rest", () => {
    const items = ["aa", "bb", "cc"]; // 4 bytes as JSON, 5 with the separator
    expect(fitItems(items, 15)).toEqual({ kept: items, omitted: 0, used: 15 });
    expect(fitItems(items, 14)).toEqual({ kept: ["aa", "bb"], omitted: 1, used: 10 });
    expect(fitItems(items, 4)).toEqual({ kept: [], omitted: 3, used: 0 });
    expect(fitItems([], 10)).toEqual({ kept: [], omitted: 0, used: 0 });
  });

  it("stops at the first item that does not fit instead of skipping to a smaller later one", () => {
    expect(fitItems(["a", "x".repeat(50), "b"], 20)).toMatchObject({ kept: ["a"], omitted: 2 });
  });
});

describe("clipFields", () => {
  it("cuts long text and long lists, flags it, and leaves identifiers whole", () => {
    const long = "x".repeat(2_000);
    const { value, clipped } = clipFields({
      id: long,
      url: long,
      body: long,
      items: Array.from({ length: 25 }, (_, index) => index),
    });
    expect(clipped).toBe(true);
    expect(value.id).toBe(long);
    expect(value.url).toBe(long);
    expect(value.body.length).toBe(1_024);
    expect(value.items).toHaveLength(20);
  });

  it("leaves a small record untouched and reports nothing clipped", () => {
    const record = { id: "1", body: "x".repeat(1_024), items: new Array(20).fill("a"), n: null };
    expect(clipFields(record)).toEqual({ value: record, clipped: false });
  });

  it("trims space a cut leaves at the end and keeps emoji whole", () => {
    const { value } = clipFields({ body: `${"a".repeat(1_023)} ${"b".repeat(10)}` });
    expect(value.body).toBe("a".repeat(1_023));
    const emoji = clipFields({ body: "😀".repeat(1_000) }).value.body;
    expect(emoji).toBe("😀".repeat(256));
    expect(lone.test(emoji)).toBe(false);
  });

  it("clips inside nested objects and arrays of objects", () => {
    const { value, clipped } = clipFields({
      rows: [{ text: "y".repeat(3_000), login: "z".repeat(3_000) }],
    });
    expect(clipped).toBe(true);
    expect(value.rows[0]!.text).toHaveLength(1_024);
    expect(value.rows[0]!.login).toHaveLength(3_000);
  });
});
