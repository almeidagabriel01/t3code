import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import * as Effect from "effect/Effect";

import { fromRunner } from "./textGenerationOperations.ts";
import { buildAssistantGroupRoutingPrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("group routing prompt", () => {
  const member = (n: number, instructions: string) => ({
    id: `id-${n}`,
    handle: `m${n}`,
    name: `Member ${n}`,
    role: n === 1 ? "CFO" : "",
    instructions,
  });

  it("lists the members with a short slice of their instructions and the newest chat that fits", () => {
    const { prompt } = buildAssistantGroupRoutingPrompt({
      groupName: "Money",
      members: [member(1, "x".repeat(400)), member(2, "Handles\n  design.")],
      recentMessages: Array.from({ length: 20 }, (_, n) => ({
        from: "user",
        text: `${n}`.padEnd(600, "."),
      })),
      request: "Who pays?",
    });
    expect(prompt).toContain('group chat "Money"');
    expect(prompt).toContain(`- id id-1 (@m1) Member 1, CFO: ${"x".repeat(300)}\n`);
    expect(prompt).toContain("- id id-2 (@m2) Member 2: Handles design.");
    expect(prompt).toContain("pick everyone when the request is addressed to the whole group");
    expect(prompt.endsWith("Request:\nWho pays?")).toBe(true);
    // 4,000 characters hold six of the 600-character lines, and the newest are the ones kept.
    const chat = prompt.split("Recent messages:\n")[1]!.split("\n\nRequest:")[0]!.split("\n");
    expect(chat).toHaveLength(6);
    expect(chat.at(-1)).toContain("19");
  });

  it("says so when there is no chat yet", () => {
    const { prompt } = buildAssistantGroupRoutingPrompt({
      groupName: "G",
      members: [],
      recentMessages: [],
      request: "hi",
    });
    expect(prompt).toContain("Recent messages:\n(none)");
  });
});

describe("fromRunner routing", () => {
  const input = {
    cwd: "/tmp",
    modelSelection: { instanceId: "i", model: "m" } as never,
    groupName: "G",
    members: [],
    recentMessages: [],
    request: "hi",
  };

  effectIt.effect("offers group routing only when asked, through the runner", () =>
    Effect.gen(function* () {
      const requests: Array<{ operation: string; cwd: string }> = [];
      const run = ((request: { operation: string; cwd: string }) =>
        Effect.sync(() => {
          requests.push(request);
          return { assistantIds: ["a"] };
        })) as never;
      expect(fromRunner("Plain", run).routeAssistantGroup).toBeUndefined();
      const generation = fromRunner("Routing", run, { routeAssistantGroup: true });
      expect(yield* generation.routeAssistantGroup!(input)).toEqual({ assistantIds: ["a"] });
      expect(requests).toEqual([
        expect.objectContaining({ operation: "routeAssistantGroup", cwd: "/tmp" }),
      ]);
    }),
  );
});
