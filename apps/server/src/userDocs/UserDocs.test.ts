import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
