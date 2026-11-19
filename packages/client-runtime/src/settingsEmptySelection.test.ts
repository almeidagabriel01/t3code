import { describe, expect, it } from "vite-plus/test";

import {
  allEnvironmentsLabel,
  CONNECT_ENVIRONMENT_FOR_KEYBINDINGS,
  emptyEnvironmentSelectionText,
  NO_MATCHING_ENVIRONMENTS,
} from "./settingsEmptySelection.ts";

describe("environment filter wording", () => {
  it.each([
    [0, "No environments", CONNECT_ENVIRONMENT_FOR_KEYBINDINGS],
    [1, "All environments", NO_MATCHING_ENVIRONMENTS],
    [3, "All environments", NO_MATCHING_ENVIRONMENTS],
  ])("%i environments", (count, label, empty) => {
    expect(allEnvironmentsLabel(count)).toBe(label);
    expect(emptyEnvironmentSelectionText(CONNECT_ENVIRONMENT_FOR_KEYBINDINGS, count > 0)).toBe(
      empty,
    );
  });
});
