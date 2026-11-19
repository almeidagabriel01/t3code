import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AssistantTeamId } from "./assistants.ts";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { ConsumerRef, consumerRefFromThread } from "./consumer.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeConsumerRef = Schema.decodeSync(ConsumerRef);
const environmentId = EnvironmentId.make("env-mac");
const providerInstanceId = ProviderInstanceId.make("claude-work");
const root = ThreadId.make("thread-root");
const groupThread = ThreadId.make("assistant:jarvis:g-0123456789abcdef");
const team = AssistantTeamId.make("team:ops");

const thread = (
  id: string,
  relationshipToParent: "fork" | "subagent" | null = null,
  parentThreadId: ThreadId | null = relationshipToParent === null ? null : root,
) => ({
  id: ThreadId.make(id),
  providerInstanceId,
  lineage: { parentThreadId, relationshipToParent, rootThreadId: root },
});

describe("consumerRefFromThread", () => {
  it.each([
    ["plain thread", thread("thread-root"), null, { kind: "thread" }],
    ["fork stays a thread", thread("thread-fork", "fork"), null, { kind: "thread" }],
    ["assistant", thread("assistant:jarvis:3"), null, { kind: "assistant", assistantId: "jarvis" }],
    [
      "group member",
      thread(groupThread),
      team,
      { kind: "groupMember", assistantId: "jarvis", groupId: team },
    ],
    [
      "group member without the group table",
      thread(groupThread),
      null,
      { kind: "groupMember", assistantId: "jarvis", groupId: null },
    ],
    [
      "subagent",
      thread("thread-child", "subagent"),
      null,
      { kind: "subagent", parentThreadId: root },
    ],
    [
      "subagent without a parent reads as a thread",
      thread("thread-orphan", "subagent", null),
      null,
      { kind: "thread" },
    ],
  ] as const)("%s", (_name, input, groupId, expected) => {
    const ref = consumerRefFromThread(input, environmentId, groupId);
    expect(ref).toEqual({ ...expected, threadId: input.id, environmentId, providerInstanceId });
    expect(decodeConsumerRef(ref)).toEqual(ref);
  });
});
