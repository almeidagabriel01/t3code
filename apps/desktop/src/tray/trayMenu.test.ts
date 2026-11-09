import { describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import type { DesktopTrayMenu, DesktopTrayThread } from "@t3tools/contracts";

import { SECTION_ROWS, trayLabel, trayMenuTemplate } from "./trayMenu.ts";
import { createTrayMenuGate } from "./trayMenuGate.ts";
import { TrayMenuPayload } from "./trayMenuPayload.ts";

const thread = (n: number, extra: Partial<DesktopTrayThread> = {}): DesktopTrayThread => ({
  environmentId: "env",
  threadId: `t${n}`,
  title: `Thread ${n}`,
  project: null,
  environment: null,
  ...extra,
});
const threads = (count: number) => Array.from({ length: count }, (_, i) => thread(i));
const menu = (partial: Partial<DesktopTrayMenu>): DesktopTrayMenu => ({
  attention: [],
  running: [],
  pinned: [],
  attentionCount: 0,
  ...partial,
});
const actions = () => ({
  openApp: vi.fn(),
  newThread: vi.fn(),
  openThread: vi.fn(),
  quit: vi.fn(),
});
const build = (m: DesktopTrayMenu, nativeHeaders = true, a = actions()) =>
  trayMenuTemplate({ menu: m, appName: "T3 Code", nativeHeaders, actions: a });
const shape = (template: ReturnType<typeof build>) =>
  template.map((item) => (item.type === "separator" ? "---" : item.label));

describe("trayMenuTemplate", () => {
  it.each([
    { name: "all empty", menu: menu({}), labels: ["Nothing running"] },
    {
      name: "one section only",
      menu: menu({ running: threads(1) }),
      labels: ["Running", "Thread 0"],
    },
    {
      name: "sections in order, separated",
      menu: menu({ pinned: threads(1), attention: threads(1), running: threads(1) }),
      labels: ["Needs you", "Thread 0", "---", "Running", "Thread 0", "---", "Pinned", "Thread 0"],
    },
    {
      name: "cap with Show all",
      menu: menu({ attention: threads(SECTION_ROWS + 1) }),
      labels: [
        "Needs you",
        ...Array.from({ length: SECTION_ROWS }, (_, i) => `Thread ${i}`),
        "Show all…",
      ],
    },
    {
      name: "exactly the cap has no Show all",
      menu: menu({ attention: threads(SECTION_ROWS) }),
      labels: ["Needs you", ...Array.from({ length: SECTION_ROWS }, (_, i) => `Thread ${i}`)],
    },
  ])("$name", ({ menu: input, labels }) => {
    expect(shape(build(input))).toEqual([
      ...labels,
      "---",
      "New thread",
      "Open T3 Code",
      "---",
      "Quit T3 Code",
    ]);
  });

  it("uses a disabled row for headers before macOS 14", () => {
    const [header] = build(menu({ running: threads(1) }), false);
    expect(header).toEqual({ label: "Running", enabled: false });
    expect(build(menu({ running: threads(1) }))[0]).toEqual({ type: "header", label: "Running" });
  });

  it("shows project and environment as the sublabel and routes clicks", () => {
    const a = actions();
    const target = thread(1, { project: "Proj", environment: "Laptop" });
    const items = build(menu({ pinned: [target, thread(2, { project: "Only" })] }), true, a);
    expect(items[1]).toMatchObject({ label: "Thread 1", sublabel: "Proj · Laptop" });
    expect(items[2]).toMatchObject({ sublabel: "Only" });
    expect(build(menu({ pinned: [thread(3)] }))[1]).not.toHaveProperty("sublabel");
    items[1]!.click!({} as never, undefined, {} as never);
    expect(a.openThread).toHaveBeenCalledWith(target);
    const tail = items.slice(-5);
    for (const index of [1, 2, 4]) tail[index]!.click!({} as never, undefined, {} as never);
    expect([a.newThread, a.openApp, a.quit].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("Show all opens the app", () => {
    const a = actions();
    const items = build(menu({ running: threads(SECTION_ROWS + 2) }), true, a);
    items[SECTION_ROWS + 1]!.click!({} as never, undefined, {} as never);
    expect(a.openApp).toHaveBeenCalledOnce();
  });
});

describe("trayLabel", () => {
  it.each([
    ["short", "short"],
    ["  spaced \n out  ", "spaced out"],
    ["", "Untitled thread"],
    ["   ", "Untitled thread"],
    ["a & b", "a && b"],
    ["x".repeat(41), `${"x".repeat(39)}…`],
    ["😀".repeat(41), `${"😀".repeat(39)}…`],
  ])("%j -> %j", (input, expected) => {
    expect(trayLabel(input)).toBe(expected);
  });
});

describe("createTrayMenuGate", () => {
  it("applies changes, skips repeats, and holds updates while the menu is open", () => {
    const apply = vi.fn();
    const gate = createTrayMenuGate<string>("a", apply);
    gate.update("b");
    gate.update("b");
    expect(apply.mock.calls).toEqual([["b"]]);
    gate.opened();
    gate.update("c");
    gate.update("d");
    expect(apply).toHaveBeenCalledOnce();
    gate.closed();
    expect(apply.mock.calls).toEqual([["b"], ["d"]]);
    gate.closed();
    expect(apply).toHaveBeenCalledTimes(2);
    gate.reapply();
    expect(apply).toHaveBeenCalledTimes(3);
  });
});

describe("TrayMenuPayload", () => {
  const decode = Schema.decodeUnknownSync(TrayMenuPayload);
  const valid = { attention: [thread(1)], running: [], pinned: [], attentionCount: 1 };

  it("accepts a menu and null", () => {
    expect(decode(valid)).toEqual(valid);
    expect(decode(null)).toBeNull();
  });

  it.each([
    ["negative count", { ...valid, attentionCount: -1 }],
    ["fractional count", { ...valid, attentionCount: 0.5 }],
    ["too many rows", { ...valid, running: threads(21) }],
    ["empty thread id", { ...valid, attention: [thread(1, { threadId: "" })] }],
    ["missing section", { attention: [], running: [], attentionCount: 0 }],
    ["huge title", { ...valid, attention: [thread(1, { title: "x".repeat(1_001) })] }],
  ])("rejects %s", (_name, payload) => {
    expect(() => decode(payload)).toThrow();
  });
});
