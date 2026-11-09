import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
              loadPreferencesJson: Effect.succeed(
                Option.some({ payload: JSON.stringify(payload), updatedAt: 1 }),
              ),
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
          homeAgentsDoneExpanded: false,
          homeAssistantsShowAll: true,
        }),
      ).toEqual({
        homeAssistantsCollapsed: true,
        homeAgentsDoneExpanded: false,
        homeAssistantsShowAll: true,
      });
      expect(
        yield* loadFrom({
          homeAssistantsCollapsed: "yes",
          homeAgentsDoneExpanded: 1,
          homeAssistantsShowAll: "x",
        }),
      ).toEqual({});
    }),
  );

  it.effect("keeps a known usage reset display and drops anything else", () =>
    Effect.gen(function* () {
      expect(yield* loadFrom({ usageResetDisplay: "both" })).toEqual({ usageResetDisplay: "both" });
      expect(yield* loadFrom({ usageResetDisplay: "weekday" })).toEqual({});
    }),
  );
});
