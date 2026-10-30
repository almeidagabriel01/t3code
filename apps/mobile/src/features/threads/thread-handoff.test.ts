import { ProviderInstanceId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import {
  buildHandoffInput,
  canHandoffThread,
  canStartHandoff,
  DEFAULT_HANDOFF_MODE,
  resolveHandoffAgents,
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

  it("builds the RPC input with the picked mode and mobile source", () => {
    const sourceThreadId = ThreadId.make("thread-1");
    expect(DEFAULT_HANDOFF_MODE).toBe("focused");
    expect(
      buildHandoffInput({
        sourceThreadId,
        modelSelection: codex,
        mode: "full",
        clientRequestId: "req-1",
      }),
    ).toEqual({
      sourceThreadId,
      modelSelection: codex,
      mode: "full",
      creationSource: "mobile",
      clientRequestId: "req-1",
    });
  });
});
