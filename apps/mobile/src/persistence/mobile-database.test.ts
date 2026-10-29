import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

import * as MobileDatabase from "./mobile-database";

describe("offline pull request cache", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  async function sqliteDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
        yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
        expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
          Option.some('{"entries":[]}'),
        );
        yield* database.clearEnvironmentCache(environmentId);
        expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
          "None",
        );
        expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
          "Some",
        );
      }),
    ),
  );
});

describe("note outbox", () => {
  it.effect("keeps one row per note, oldest first, until removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"));
        const sqlite = new DatabaseSync(":memory:");
        const database = {
          execAsync: async (sql: string) => {
            sqlite.exec(sql);
          },
          runAsync: async (sql: string, ...args: Array<string | number>) =>
            sqlite.prepare(sql).run(...args),
          getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
            sqlite.prepare(sql).get(...args),
          getAllAsync: async (sql: string, ...args: Array<string | number>) =>
            sqlite.prepare(sql).all(...args),
          withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
            await run(database);
          },
          closeAsync: async () => {
            sqlite.close();
          },
        };
        openDatabaseAsync.mockResolvedValueOnce(database);
        const store = yield* MobileDatabase.make;
        yield* store.saveNoteOutbox("hub", "b.md", "b1", 2);
        yield* store.saveNoteOutbox("hub", "a.md", "a1", 1);
        yield* store.saveNoteOutbox("hub", "b.md", "b2", 3);
        yield* store.saveNoteOutbox("other", "a.md", "other", 4);
        expect(yield* store.loadNoteOutbox).toEqual(["a1", "b2", "other"]);
        yield* store.removeNoteOutbox("hub", "a.md");
        expect(yield* store.loadNoteOutbox).toEqual(["b2", "other"]);
      }),
    ),
  );
});
