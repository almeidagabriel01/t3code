import type { Assistant, AssistantTeam, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ASSISTANT_ENVIRONMENT_COPY as C,
  assistantEnvironmentPicker,
  assistantEnvironmentUpdate,
  assistantTeamEnvironmentFields,
  defaultEnvironmentOf,
  supportsDefaultEnvironment,
  type AssistantEnvironmentPickerInput,
  type AssistantEnvironmentValue,
} from "./assistantEnvironment.ts";

const devbox = "env-devbox" as EnvironmentId;
const gone = "env-gone" as EnvironmentId;
const links = new Map([[devbox, "devbox"]]);

type Kind = "assistant" | "sandbox" | "project" | "group";
const subjectOf = (
  kind: Kind,
): Pick<AssistantEnvironmentPickerInput, "subject" | "workspace" | "scope"> =>
  kind === "group"
    ? { subject: "group" }
    : {
        subject: "assistant",
        workspace: kind === "sandbox" ? "sandbox" : "host",
        scope: kind === "project" ? "project" : "all",
      };

/** Options as `label` with a trailing `*` on the checked one. */
const render = (
  kind: Kind,
  value: AssistantEnvironmentValue,
  linksEnabled: boolean,
  known: ReadonlyMap<EnvironmentId, string> | null = links,
) => {
  const picker = assistantEnvironmentPicker({
    ...subjectOf(kind),
    value,
    links: known,
    linksEnabled,
  });
  return {
    current: picker.current,
    disabled: picker.disabledReason,
    notice: picker.notice,
    options: picker.options.map((option) => `${option.label}${option.selected ? "*" : ""}`),
  };
};

const ON = ["Local", "devbox", "Auto"];
const OFF = ["Local"];

describe("assistantEnvironmentPicker", () => {
  it.each([
    // assistant, links on
    ["assistant", null, true, C.assistantInherit, null, null, ["Local*", "devbox", "Auto"]],
    ["assistant", "local", true, C.local, null, null, ["Local*", "devbox", "Auto"]],
    ["assistant", "auto", true, C.auto, null, null, ["Local", "devbox", "Auto*"]],
    ["assistant", devbox, true, "devbox", null, null, ["Local", "devbox*", "Auto"]],
    [
      "assistant",
      gone,
      true,
      C.unavailable,
      null,
      null,
      [...ON.slice(0, 2), `${C.unavailable}*`, "Auto"],
    ],
    // assistant, links off: everything runs locally and the notice says why
    ["assistant", null, false, C.assistantInherit, null, C.linksOff, ["Local*"]],
    ["assistant", "local", false, C.local, null, C.linksOff, ["Local*"]],
    ["assistant", "auto", false, C.local, null, C.linksOff, OFF],
    ["assistant", devbox, false, C.local, null, C.linksOff, OFF],
    ["assistant", gone, false, C.local, null, C.linksOff, OFF],
    // sandbox and project assistants cannot change it, whatever is stored
    [
      "sandbox",
      devbox,
      true,
      C.sandboxCurrent,
      C.sandboxDisabled,
      null,
      ["Local", "devbox*", "Auto"],
    ],
    ["sandbox", null, false, C.sandboxCurrent, C.sandboxDisabled, null, ["Local*"]],
    ["project", "auto", true, C.local, C.projectDisabled, null, ["Local", "devbox", "Auto*"]],
    ["project", null, false, C.local, C.projectDisabled, null, ["Local*"]],
    // group: null is its own row
    ["group", null, true, C.groupInherit, null, null, [`${C.groupInherit}*`, ...ON]],
    ["group", "local", true, C.local, null, null, [C.groupInherit, "Local*", "devbox", "Auto"]],
    ["group", "auto", true, C.auto, null, null, [C.groupInherit, "Local", "devbox", "Auto*"]],
    ["group", devbox, true, "devbox", null, null, [C.groupInherit, "Local", "devbox*", "Auto"]],
    [
      "group",
      gone,
      true,
      C.unavailable,
      null,
      null,
      [C.groupInherit, "Local", "devbox", `${C.unavailable}*`, "Auto"],
    ],
    ["group", null, false, C.groupInherit, null, C.linksOff, [`${C.groupInherit}*`, "Local"]],
    ["group", devbox, false, C.local, null, C.linksOff, [C.groupInherit, "Local"]],
  ] as const)(
    "%s · %s · links %s",
    (kind, value, linksEnabled, current, disabled, notice, options) => {
      expect(render(kind, value, linksEnabled)).toEqual({ current, disabled, notice, options });
    },
  );

  it("names a stored link generically until the links load, then by its label", () => {
    expect(render("assistant", devbox, true, null)).toMatchObject({
      current: C.linkedMachine,
      options: ["Local", "Auto"],
    });
  });

  it("lists links by name", () => {
    const many = new Map([
      ["env-z" as EnvironmentId, "zeta"],
      ["env-a" as EnvironmentId, "alpha"],
    ]);
    expect(render("assistant", null, true, many).options).toEqual([
      "Local*",
      "alpha",
      "zeta",
      "Auto",
    ]);
  });

  it("writes each choice as the value it stands for", () => {
    const picker = assistantEnvironmentPicker({
      ...subjectOf("group"),
      value: null,
      links,
      linksEnabled: true,
    });
    expect(picker.options.map((option) => option.value)).toEqual([null, "local", devbox, "auto"]);
    expect(picker.options[1]?.description).toBe(C.groupLocalDescription);
  });
});

describe("provisional contract seam", () => {
  it("reads and writes the field", () => {
    const assistant = { id: "ada", defaultEnvironment: "auto" } as unknown as Assistant;
    expect(defaultEnvironmentOf(assistant)).toBe("auto");
    expect(defaultEnvironmentOf({ id: "t" } as unknown as AssistantTeam)).toBeUndefined();
    expect(supportsDefaultEnvironment(assistant)).toBe(true);
    expect(assistantEnvironmentUpdate(assistant.id, devbox)).toEqual({
      assistantId: "ada",
      defaultEnvironment: devbox,
    });
    expect(assistantTeamEnvironmentFields(null)).toEqual({ defaultEnvironment: null });
  });
});
