import { expect, it } from "@effect/vitest";
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

import { runMemoryPrepareInput } from "./MemoryPrepareInput.ts";

type Message = Pick<
  OrchestrationV2ConversationMessage,
  "id" | "createdBy" | "creationSource" | "scheduledTaskId"
>;
const run = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, userMessageId: `message-${id}`, ...extra }) as unknown as OrchestrationV2Run;
const message = (id: string, extra: Partial<Message> = {}) =>
  ({
    id: `message-${id}`,
    createdBy: "user",
    creationSource: "web",
    ...extra,
  }) as unknown as OrchestrationV2ConversationMessage;
const projection = (runs: OrchestrationV2Run[], messages: OrchestrationV2ConversationMessage[]) =>
  ({ runs, messages }) as unknown as OrchestrationV2ThreadProjection;

it("an ordinary person-started run carries no ceiling, so current policy decides", () => {
  const first = run("a", { memoryGrantCeiling: "none" });
  const first_m = message("a");
  expect(
    runMemoryPrepareInput({
      run: first,
      message: first_m,
      projection: projection([first], [first_m]),
    }),
  ).toEqual({ memoryGrantCeiling: null });
});

it("agent, scheduled and delegated runs keep the captured ceiling", () => {
  for (const [r, m] of [
    [
      run("b", { memoryGrantCeiling: "read" }),
      message("b", { createdBy: "agent", creationSource: "mcp" }),
    ],
    [run("c", { memoryGrantCeiling: "read" }), message("c", { scheduledTaskId: "task" as never })],
    [run("d", { memoryGrantCeiling: "read", delegatedTaskId: "node" }), message("d")],
  ] as const) {
    expect(runMemoryPrepareInput({ run: r, message: m, projection: projection([r], [m]) })).toEqual(
      {
        memoryGrantCeiling: "read",
      },
    );
  }
});

it("a restart continuation inherits its origin, and a broken chain gets none", () => {
  const origin = run("origin", { memoryGrantCeiling: "none" });
  const originMessage = message("origin");
  const continuation = run("next", { restartContinuationOfRunId: "origin" });
  const continuationMessage = message("next", { createdBy: "agent", creationSource: "server" });
  expect(
    runMemoryPrepareInput({
      run: continuation,
      message: continuationMessage,
      projection: projection([origin, continuation], [originMessage, continuationMessage]),
    }),
  ).toEqual({ memoryGrantCeiling: null });
  expect(
    runMemoryPrepareInput({
      run: continuation,
      message: continuationMessage,
      projection: projection([continuation], [continuationMessage]),
    }),
  ).toEqual({ memoryGrantCeiling: "none" });
});
