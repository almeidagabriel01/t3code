import {
  SCOPE_ACCESS_CHECKING_MESSAGE,
  SCOPE_ACCESS_UNAVAILABLE_MESSAGE,
} from "@t3tools/client-runtime/state/sessionScope";
import { expect, it } from "vite-plus/test";

import { noModelHint } from "./VoiceModelSection.logic";

it.each([
  ["granted", "Choose one to download"],
  ["missing", "Add one using T3 Code on Studio"],
  ["unknown", SCOPE_ACCESS_CHECKING_MESSAGE],
  ["unavailable", SCOPE_ACCESS_UNAVAILABLE_MESSAGE],
] as const)("a row without a model reads %s access", (access, text) => {
  expect(noModelHint(access, "Studio")).toBe(text);
});
