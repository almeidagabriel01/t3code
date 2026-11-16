import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

const loadFrom = (payload: object) =>
  MobilePreferences.MobilePreferencesStore.pipe(
    Effect.flatMap((store) => store.load),
    Effect.provide(
      MobilePreferences.layer.pipe(
        Layer.provide(
          Layer.succeed(
            MobileDatabase.MobileDatabase,
            MobileDatabase.MobileDatabase.of({
              loadPreferencesJson: Effect.succeedSome({
                payload: JSON.stringify(payload),
                updatedAt: 1,
              }),
              savePreferencesJson: () => Effect.void,
            } as never),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            MobileSecureStorage.MobileSecureStorage,
            MobileSecureStorage.MobileSecureStorage.of({
              getItem: () => Effect.succeed(null),
              setItem: () => Effect.void,
              removeItem: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  );

describe("mobile preferences parser", () => {
  it.effect("keeps the Home section fold booleans and drops other types", () =>
    Effect.gen(function* () {
      expect(
        yield* loadFrom({
          homeAssistantsCollapsed: true,
          homeAssistantsShowAll: true,
          homeAssistantsFolded: ["hub:a1", 3, null, "hub:a2"],
          homeAssistantsExpandedGroups: ["group:env:t1", 3, null, "group:env:t2"],
          // Saved by builds that had a Working shelf or the Agents section; still loads, and is dropped.
          homeAgentsDoneExpanded: true,
          workingShelfEnabled: true,
          threadListWorkingShelfExpanded: true,
        }),
      ).toEqual({
        homeAssistantsCollapsed: true,
        homeAssistantsShowAll: true,
        homeAssistantsFolded: ["hub:a1", "hub:a2"],
        homeAssistantsExpandedGroups: ["group:env:t1", "group:env:t2"],
      });
      expect(
        yield* loadFrom({
          homeAssistantsCollapsed: "yes",
          homeAssistantsShowAll: "x",
          homeAssistantsFolded: "hub:a1",
          homeAssistantsExpandedGroups: "group:env:t1",
        }),
      ).toEqual({});
    }),
  );

  it.effect("keeps each group's saved chat tab and drops the ones that are not text", () =>
    Effect.gen(function* () {
      expect(
        yield* loadFrom({ assistantGroupTabs: { "hub:g1": "project:p1", "hub:g2": 3 } }),
      ).toEqual({ assistantGroupTabs: { "hub:g1": "project:p1" } });
      expect(yield* loadFrom({ assistantGroupTabs: "all" })).toEqual({});
    }),
  );

  it.effect("keeps every valid board panel choice and drops the invalid ones", () =>
    Effect.gen(function* () {
      expect(
        yield* loadFrom({
          kanbanPanel: {
            scopes: { a: "project", b: "no-project", c: "other" },
            collapsed: { board: { todo: true, done: false, bad: "yes" }, broken: 3 },
          },
        }),
      ).toEqual({
        kanbanPanel: {
          scopes: { a: "project", b: "no-project" },
          collapsed: { board: { todo: true, done: false } },
        },
      });
      expect(yield* loadFrom({ kanbanPanel: "x" })).toEqual({});
      expect(yield* loadFrom({ kanbanPanel: {} })).toEqual({
        kanbanPanel: { scopes: {}, collapsed: {} },
      });
    }),
  );

  it.effect("keeps a known usage reset display and drops anything else", () =>
    Effect.gen(function* () {
      expect(yield* loadFrom({ usageResetDisplay: "both" })).toEqual({ usageResetDisplay: "both" });
      expect(yield* loadFrom({ usageResetDisplay: "weekday" })).toEqual({});
    }),
  );
});
