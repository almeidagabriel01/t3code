// @effect-diagnostics nodeBuiltinImport:off - Resolves the repository's docs/user beside this module in source runs.
import * as NodeURL from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  parseUserGuide,
  searchUserGuides,
  type UserGuideMatch,
  type UserGuidePage,
} from "./userGuides.ts";

/** The guides the server pack build inlines (apps/server/vite.config.ts); absent in source runs. */
declare const __T3CODE_USER_DOCS__: Readonly<Record<string, string>> | undefined;

/** Characters of markdown one read returns before it continues through a cursor. */
export const USER_GUIDE_READ_LIMIT = 16_000;

export class UserDocsUnavailableError extends Schema.TaggedError<UserDocsUnavailableError>()(
  "UserDocsUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The user guides are not available on this server: ${this.reason}`;
  }
}

export class UserGuideNotFoundError extends Schema.TaggedError<UserGuideNotFoundError>()(
  "UserGuideNotFoundError",
  {
    page: Schema.String,
    heading: Schema.optionalKey(Schema.String),
    nearest: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const target = this.heading === undefined ? this.page : `${this.page} > ${this.heading}`;
    return this.nearest.length === 0
      ? `No user guide matches ${target}.`
      : `No user guide matches ${target}. Nearest: ${this.nearest.join(", ")}.`;
  }
}

export class UserGuideCursorError extends Schema.TaggedError<UserGuideCursorError>()(
  "UserGuideCursorError",
  {},
) {
  override get message(): string {
    return "The cursor is past the end of this page or section; read it again without one.";
  }
}

export interface UserGuideRead {
  readonly page: string;
  readonly title: string;
  readonly heading: string | null;
  readonly markdown: string;
  /** The page's sections, to pass back as `heading`; only for a whole-page read from the start. */
  readonly sections: ReadonlyArray<string>;
  readonly truncated: boolean;
  readonly nextCursor: number | null;
}

export class UserDocs extends Context.Service<
  UserDocs,
  {
    readonly search: (input: { readonly query: string; readonly limit: number }) => Effect.Effect<
      {
        readonly matches: ReadonlyArray<UserGuideMatch>;
        readonly total: number;
      },
      UserDocsUnavailableError
    >;
    readonly index: Effect.Effect<
      ReadonlyArray<{ readonly page: string; readonly title: string }>,
      UserDocsUnavailableError
    >;
    readonly read: (input: {
      readonly page: string;
      readonly heading?: string | undefined;
      readonly cursor?: number | undefined;
    }) => Effect.Effect<
      UserGuideRead,
      UserDocsUnavailableError | UserGuideNotFoundError | UserGuideCursorError
    >;
  }
>()("t3/userDocs/UserDocs") {}

const pageOf = (file: string) => file.replace(/\.md$/, "");

/** The inlined guides in a packed build, else the repository's docs/user beside this module. */
const loadGuides = Effect.gen(function* () {
  const bundled = typeof __T3CODE_USER_DOCS__ === "undefined" ? undefined : __T3CODE_USER_DOCS__;
  if (bundled !== undefined)
    return Object.entries(bundled).map(([page, markdown]) => parseUserGuide(page, markdown));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = NodeURL.fileURLToPath(new URL("../../../../docs/user/", import.meta.url));
  const files = yield* fs
    .readDirectory(directory)
    .pipe(
      Effect.mapError(() => new UserDocsUnavailableError({ reason: "this build has no guides" })),
    );
  return yield* Effect.forEach(files.filter((file) => file.endsWith(".md")).sort(), (file) =>
    fs.readFileString(path.join(directory, file)).pipe(
      Effect.map((markdown) => parseUserGuide(pageOf(file), markdown)),
      Effect.mapError(() => new UserDocsUnavailableError({ reason: `${file} could not be read` })),
    ),
  );
});

/** Pages whose id or title shares the most words with what was asked for. */
const nearestPages = (pages: ReadonlyArray<UserGuidePage>, asked: string) => {
  const words = asked
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return pages
    .map((page) => ({
      page: page.page,
      hits: words.filter(
        (word) => page.page.includes(word) || page.title.toLowerCase().includes(word),
      ).length,
    }))
    .filter((entry) => entry.hits > 0)
    .toSorted((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((entry) => entry.page);
};

/** Up to the read limit, ending on a line boundary when one is near. */
const window = (text: string, offset: number) => {
  if (text.length - offset <= USER_GUIDE_READ_LIMIT)
    return { markdown: text.slice(offset), next: null };
  const hardEnd = offset + USER_GUIDE_READ_LIMIT;
  const lineEnd = text.lastIndexOf("\n", hardEnd);
  const end = lineEnd > offset + USER_GUIDE_READ_LIMIT / 2 ? lineEnd + 1 : hardEnd;
  return { markdown: text.slice(offset, end), next: end };
};

const make = Effect.gen(function* () {
  // Loaded once: inlined text costs nothing, and a source run reads a few dozen small files.
  const loaded = yield* Effect.exit(loadGuides);
  const pages: Effect.Effect<
    ReadonlyArray<UserGuidePage>,
    UserDocsUnavailableError
  > = Exit.isSuccess(loaded) ? Effect.succeed(loaded.value) : Effect.failCause(loaded.cause);

  const search: UserDocs["Service"]["search"] = ({ query, limit }) =>
    pages.pipe(
      Effect.map((guides) => {
        const found = searchUserGuides(guides, query);
        return { matches: found.matches.slice(0, limit), total: found.matches.length };
      }),
    );

  const index: UserDocs["Service"]["index"] = pages.pipe(
    Effect.map((guides) =>
      guides
        .map(({ page, title }) => ({ page, title }))
        .toSorted((a, b) => a.title.localeCompare(b.title, "en")),
    ),
  );

  const read: UserDocs["Service"]["read"] = Effect.fn("UserDocs.read")(function* ({
    page,
    heading,
    cursor = 0,
  }) {
    const guides = yield* pages;
    const guide = guides.find((candidate) => candidate.page === pageOf(page.trim().toLowerCase()));
    if (guide === undefined)
      return yield* new UserGuideNotFoundError({ page, nearest: nearestPages(guides, page) });
    const wanted = heading?.trim().toLowerCase().replace(/^#/, "");
    const part =
      wanted === undefined
        ? undefined
        : guide.sections.find(
            (candidate) =>
              candidate.anchor === wanted || candidate.heading.toLowerCase() === wanted,
          );
    if (wanted !== undefined && part === undefined)
      return yield* new UserGuideNotFoundError({
        page: guide.page,
        heading: heading ?? "",
        nearest: guide.sections
          .filter((candidate) =>
            wanted.split(/\s+/).some((word) => candidate.heading.toLowerCase().includes(word)),
          )
          .slice(0, 3)
          .map((candidate) => candidate.heading),
      });
    const text =
      part === undefined
        ? guide.markdown
        : `${"#".repeat(part.depth)} ${part.heading}\n\n${part.text}`;
    if (cursor > 0 && cursor >= text.length) return yield* new UserGuideCursorError();
    const { markdown, next } = window(text, cursor);
    return {
      page: guide.page,
      title: guide.title,
      heading: part?.heading ?? null,
      markdown,
      sections: part === undefined && cursor === 0 ? guide.sections.map((s) => s.heading) : [],
      truncated: next !== null,
      nextCursor: next,
    };
  });

  return UserDocs.of({ search, index, read });
});

export const layer = Layer.effect(UserDocs, make);
