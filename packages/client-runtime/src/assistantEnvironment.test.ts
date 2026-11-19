import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantEnvironmentChoice,
  assistantEnvironmentInput,
  type AssistantEnvironmentLink,
} from "./assistantEnvironment.ts";

const id = (value: string) => value as EnvironmentId;
const SERVER = id("server-env");
const devbox: AssistantEnvironmentLink = {
  environmentId: id("devbox-env-0001"),
  label: "devbox",
  status: "reachable",
};
const laptop: AssistantEnvironmentLink = {
  environmentId: id("laptop-env-0002"),
  label: "Laptop",
  status: "unreachable",
};
const old: AssistantEnvironmentLink = {
  environmentId: id("old-env-0003"),
  label: "Old box",
  status: "expired",
};

describe("assistantEnvironmentChoice", () => {
  it.each([
    {
      name: "unset is Local",
      input: { value: null, links: [devbox] },
      expected: { selected: "local", display: "Local", options: ["Local", "devbox", "Auto"] },
    },
    {
      name: "absent is Local",
      input: { value: undefined, links: [] },
      expected: { selected: "local", display: "Local", options: ["Local", "Auto"] },
    },
    {
      name: "the server's own id is Local",
      input: { value: SERVER, links: [devbox] },
      expected: { selected: "local", display: "Local", options: ["Local", "devbox", "Auto"] },
    },
    {
      name: "a link shows its name and an unreachable one says so",
      input: { value: devbox.environmentId, links: [devbox, laptop] },
      expected: {
        selected: devbox.environmentId,
        display: "devbox",
        options: ["Local", "devbox", "Laptop (Not answering now)", "Auto"],
      },
    },
    {
      name: "Auto",
      input: { value: "auto" as const, links: [devbox] },
      expected: { selected: "auto", display: "Auto", options: ["Local", "devbox", "Auto"] },
    },
    {
      name: "an unlinked id is unavailable, before Auto",
      input: { value: id("gone-environment"), links: [devbox] },
      expected: {
        selected: "gone-environment",
        display: "Unavailable (gone-env…)",
        options: ["Local", "devbox", "Unavailable (gone-env…)", "Auto"],
      },
    },
    {
      name: "an expired link keeps its name but is not offered otherwise",
      input: { value: old.environmentId, links: [old] },
      expected: {
        selected: old.environmentId,
        display: "Old box (expired)",
        options: ["Local", "Old box (expired)", "Auto"],
      },
    },
    {
      name: "an expired link nobody picked is left out",
      input: { value: null, links: [old] },
      expected: { selected: "local", display: "Local", options: ["Local", "Auto"] },
    },
    {
      name: "a group with no default of its own follows its members",
      input: { value: null, links: [devbox], group: true },
      expected: {
        selected: "members",
        display: "Members' defaults",
        options: ["Members' defaults", "Local", "devbox", "Auto"],
      },
    },
    {
      name: "a group's Local is its own choice",
      input: { value: "local" as const, links: [devbox], group: true },
      expected: {
        selected: "local",
        display: "Local",
        options: ["Members' defaults", "Local", "devbox", "Auto"],
      },
    },
    {
      name: "while links load a stored link is not called unavailable",
      input: { value: devbox.environmentId, links: null },
      expected: {
        selected: devbox.environmentId,
        display: "devbox-e…",
        options: ["Local", "devbox-e…", "Auto"],
      },
    },
  ])("$name", ({ input, expected }) => {
    const choice = assistantEnvironmentChoice({
      serverEnvironmentId: SERVER,
      linksOffered: true,
      ...input,
    });
    expect({
      selected: choice.selected,
      display: choice.display,
      options: choice.options.map((option) =>
        option.value === "local" ||
        option.value === "auto" ||
        option.value === "members" ||
        option.detail === null
          ? option.label
          : `${option.label} (${option.detail})`,
      ),
    }).toEqual(expected);
    expect(choice.disabledReason).toBeNull();
  });

  it.each([
    {
      name: "a sandbox assistant shows the sandbox",
      input: { workspace: "sandbox" as const, scope: "project" as const, linksOffered: true },
      display: "Sandbox container",
      reason: /sandbox container/,
    },
    {
      name: "a project assistant ignores the default",
      input: { workspace: "host" as const, scope: "project" as const, linksOffered: true },
      display: "Local",
      reason: /limited to projects/,
    },
    {
      name: "with linked environments off only Local is left",
      input: { workspace: "host" as const, scope: "all" as const, linksOffered: false },
      display: "Local",
      reason: /Linked environments/,
    },
  ])("$name", ({ input, display, reason }) => {
    const choice = assistantEnvironmentChoice({
      value: devbox.environmentId,
      serverEnvironmentId: SERVER,
      links: [devbox],
      ...input,
    });
    expect(choice.display).toBe(display);
    expect(choice.selected).toBe("local");
    expect(choice.options.map((option) => option.label)).toEqual(["Local"]);
    expect(choice.disabledReason).toMatch(reason);
  });
});

describe("assistantEnvironmentInput", () => {
  it.each([
    { value: "local" as const, group: false, expected: null },
    { value: "auto" as const, group: false, expected: "auto" },
    { value: devbox.environmentId, group: false, expected: devbox.environmentId },
    // Unset in a group means its members' defaults, so its Local is stored.
    { value: "local" as const, group: true, expected: "local" },
    { value: "members" as const, group: true, expected: null },
  ])("$value (group: $group) writes $expected", ({ value, group, expected }) => {
    expect(assistantEnvironmentInput(value, group)).toBe(expected);
  });
});
