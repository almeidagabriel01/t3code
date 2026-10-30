import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import {
  buildHandoffInput,
  canHandoffThread,
  canStartHandoff,
  DEFAULT_HANDOFF_MODE,
  resolveHandoffAgents,
  resolveHandoffContextChoices,
} from "./thread-handoff";

const claude: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-7",
};
const codex: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5",
};
const option = (selection: ModelSelection, label: string) =>
  ({ selection, label }) as unknown as ModelOption;
const options = [option(claude, "Claude Opus 4.7"), option(codex, "GPT-5.5")];

describe("thread handoff", () => {
  it("is offered only once the thread has a user message", () => {
    expect(canHandoffThread({ latestUserMessageAt: null })).toBe(false);
    expect(canHandoffThread({ latestUserMessageAt: "2026-01-01T00:00:00.000Z" })).toBe(true);
  });

  it("shows display names for both agents, not raw ids", () => {
    expect(resolveHandoffAgents({ options, selection: codex, source: claude })).toMatchObject({
      agentLabel: "GPT-5.5",
      sourceLabel: "Claude Opus 4.7",
    });
  });

  it("falls back to the model slug only when the catalog lacks the agent", () => {
    expect(resolveHandoffAgents({ options: [], selection: null, source: claude })).toMatchObject({
      agentLabel: "Choose an agent",
      sourceLabel: "claude-opus-4-7",
    });
  });

  it("starts only with permission, an agent and no start in flight", () => {
    const ok = { permitted: true, selection: codex, starting: false };
    expect(canStartHandoff(ok)).toBe(true);
    expect(canStartHandoff({ ...ok, permitted: false })).toBe(false);
    expect(canStartHandoff({ ...ok, selection: null })).toBe(false);
    expect(canStartHandoff({ ...ok, starting: true })).toBe(false);
  });

  it("offers Summary only when the memory model can write one", () => {
    const config = (memoryEnabled: boolean, supportsTextGeneration: boolean) =>
      ({
        settings: { ...DEFAULT_SERVER_SETTINGS, memoryEnabled, memoryModelSelection: codex },
        providers: [{ instanceId: codex.instanceId, enabled: true, supportsTextGeneration }],
      }) as never;
    const summaryOf = (value: ReturnType<typeof config> | null) =>
      resolveHandoffContextChoices(value).find((choice) => choice.mode === "summary");
    expect(summaryOf(config(true, true))).toMatchObject({ disabled: false });
    expect(summaryOf(config(false, true))).toMatchObject({
      disabled: true,
      description: expect.stringContaining("Memory is turned off"),
    });
    expect(summaryOf(config(true, false))).toMatchObject({ disabled: true });
    expect(summaryOf(null)).toMatchObject({ disabled: true });
    expect(resolveHandoffContextChoices(null).filter((choice) => choice.disabled)).toHaveLength(1);
  });

  it("builds the RPC input with the picked mode and mobile source", () => {
    const sourceThreadId = ThreadId.make("thread-1");
    expect(DEFAULT_HANDOFF_MODE).toBe("focused");
    expect(
      buildHandoffInput({
        sourceThreadId,
        modelSelection: codex,
        mode: "full",
        clientRequestId: "req-1",
        instructions: "  Add tests.  ",
      }),
    ).toEqual({
      sourceThreadId,
      modelSelection: codex,
      mode: "full",
      creationSource: "mobile",
      clientRequestId: "req-1",
      instructions: "Add tests.",
    });
    expect(
      buildHandoffInput({
        sourceThreadId,
        modelSelection: codex,
        mode: "full",
        clientRequestId: "req-1",
        instructions: "   ",
      }),
    ).not.toHaveProperty("instructions");
  });
});
