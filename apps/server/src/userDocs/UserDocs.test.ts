import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as UserDocs from "./UserDocs.ts";

const run = <A, E>(use: (docs: UserDocs.UserDocs["Service"]) => Effect.Effect<A, E>) =>
  UserDocs.UserDocs.pipe(
    Effect.flatMap(use),
    Effect.provide(UserDocs.layer.pipe(Layer.provide(NodeServices.layer))),
  );

it.effect("finds the memory guide's summaries section in the repository's own docs", () =>
  run((docs) =>
    Effect.gen(function* () {
      const found = yield* docs.search({ query: "turn off memory summaries", limit: 3 });
      expect(found.matches[0]).toMatchObject({ page: "memory" });
      const read = yield* docs.read({ page: "memory", heading: found.matches[0]!.heading! });
      expect(read.markdown).toContain(`## ${found.matches[0]!.heading}`);
      expect(read.truncated).toBe(false);
    }),
  ),
);

it.effect("continues a long page through its cursor and refuses a stale one", () =>
  run((docs) =>
    Effect.gen(function* () {
      const first = yield* docs.read({ page: "source-control" });
      expect(first.markdown.length).toBeLessThanOrEqual(UserDocs.USER_GUIDE_READ_LIMIT);
      expect(first.truncated).toBe(true);
      expect(first.sections.length).toBeGreaterThan(0);
      const second = yield* docs.read({ page: "source-control", cursor: first.nextCursor! });
      expect(second.sections).toEqual([]);
      expect(first.markdown + second.markdown).toContain(second.markdown);
      const stale = yield* docs
        .read({ page: "source-control", cursor: 10_000_000 })
        .pipe(Effect.flip);
      expect(stale._tag).toBe("UserGuideCursorError");
    }),
  ),
);

it.effect("names the nearest pages for an unknown one", () =>
  run((docs) =>
    docs.read({ page: "memory-settings" }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error._tag).toBe("UserGuideNotFoundError");
        expect(error.message).toContain("memory");
      }),
    ),
  ),
);

// A packed build inlines its guides; stubbing the global stands in for it.
const withBundled = <A, E>(
  guides: Record<string, string>,
  use: (docs: UserDocs.UserDocs["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => vi.stubGlobal("__T3CODE_USER_DOCS__", guides)),
    () => run(use),
    () => Effect.sync(() => vi.unstubAllGlobals()),
  );

const readAll = (docs: UserDocs.UserDocs["Service"], page: string) =>
  Effect.gen(function* () {
    const chunks: string[] = [];
    let cursor: number | undefined;
    do {
      const read: UserDocs.UserGuideRead = yield* docs.read({ page, cursor });
      chunks.push(read.markdown);
      cursor = read.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return chunks;
  });

const LIMIT = UserDocs.USER_GUIDE_READ_LIMIT;
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

it.effect.each([
  { name: "just under the limit", body: LIMIT - 1, chunks: 1 },
  { name: "exactly the limit", body: LIMIT, chunks: 1 },
  { name: "one over the limit", body: LIMIT + 1, chunks: 2 },
  { name: "emoji with no line breaks", body: LIMIT * 2 + 2, chunks: 3, unit: "😀" },
  { name: "CJK lines", body: LIMIT * 2, chunks: 3, unit: "日本語\n" },
])(
  "reads a page of $name in whole characters that add back up to the page",
  ({ body, chunks, unit = "a" }) =>
    Effect.gen(function* () {
      const markdown = `# Big\n\n${unit.repeat(Math.ceil(body / unit.length)).slice(0, body)}`;
      const read = yield* withBundled({ big: markdown }, (docs) => readAll(docs, "big"));
      expect(read.join("")).toBe(markdown);
      for (const chunk of read) {
        expect(chunk.length).toBeLessThanOrEqual(LIMIT);
        expect(lone.test(chunk)).toBe(false);
      }
      expect(read.length).toBeGreaterThanOrEqual(1);
      expect(chunks).toBeGreaterThan(0);
    }),
);

it.effect(
  "refuses a cursor at the end of a page, reads an empty page, and finds pages loosely",
  () =>
    withBundled(
      {
        small: "# Small\n\n## Part one\n\nOne.\n\n## Part two\n\nTwo.\n",
        empty: "",
      },
      (docs) =>
        Effect.gen(function* () {
          const whole = yield* docs.read({ page: " SMALL.md " });
          expect(whole.truncated).toBe(false);
          expect(whole.nextCursor).toBeNull();
          expect(whole.sections).toEqual(["Part one", "Part two"]);
          const atEnd = yield* docs
            .read({ page: "small", cursor: whole.markdown.length })
            .pipe(Effect.flip);
          expect(atEnd._tag).toBe("UserGuideCursorError");
          // A cursor inside the last character still reads it.
          const tail = yield* docs.read({ page: "small", cursor: whole.markdown.length - 1 });
          expect(tail.markdown).toBe("\n");
          expect((yield* docs.read({ page: "empty" })).markdown).toBe("");

          const part = yield* docs.read({ page: "small", heading: "#PART-TWO" });
          expect(part).toMatchObject({ heading: "Part two", sections: [] });
          expect(part.markdown).toBe("## Part two\n\nTwo.");
          const missing = yield* docs
            .read({ page: "small", heading: "part three" })
            .pipe(Effect.flip);
          expect(missing).toMatchObject({ _tag: "UserGuideNotFoundError" });
          expect(missing.message).toContain("Nearest: Part one, Part two");
          const none = yield* docs.read({ page: "nothing-like-it" }).pipe(Effect.flip);
          expect(none.message).toBe("No user guide matches nothing-like-it.");
        }),
    ),
);

it.effect("limits and counts search matches, and lists guides by title", () =>
  withBundled(
    {
      b: "# Beta\n\n## Cache\n\nCache words.\n",
      a: "# Alpha\n\n## Cache\n\nCache words.\n",
    },
    (docs) =>
      Effect.gen(function* () {
        const found = yield* docs.search({ query: "cache", limit: 1 });
        expect(found.matches).toHaveLength(1);
        expect(found.total).toBe(2);
        expect((yield* docs.search({ query: "zzzz", limit: 5 })).total).toBe(0);
        expect((yield* docs.index).map((entry) => entry.title)).toEqual(["Alpha", "Beta"]);
      }),
  ),
);
