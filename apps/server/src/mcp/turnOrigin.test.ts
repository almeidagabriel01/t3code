import { expect, it } from "@effect/vitest";

import { type TurnOrigin, turnOriginOf } from "./turnOrigin.ts";

type Message = NonNullable<Parameters<typeof turnOriginOf>[0]>;

const table: ReadonlyArray<readonly [string, Record<string, unknown> | undefined, TurnOrigin]> = [
  ["typed by the user", { id: "m1", createdBy: "user" }, "user"],
  ["a channel or decision answer", { id: "decision-answer:d", createdBy: "user" }, "user"],
  [
    "t3_thread_send from a thread",
    { id: "m", createdBy: "agent", senderThreadId: "t" },
    "assistant",
  ],
  ["an assistant reply", { id: "assistant-reply:r", createdBy: "agent" }, "assistant"],
  [
    "a scheduled task",
    { id: "scheduled-task-message:k", createdBy: "user", scheduledTaskId: "s" },
    "routine",
  ],
  ["a group task", { id: "group-task:t:2", createdBy: "system" }, "group"],
  ["a group task handed over", { id: "group-task:t:3", createdBy: "user" }, "group"],
  ["an autonomy wake", { id: "autonomy-wake:k", createdBy: "user" }, "other"],
  ["a background notice", { id: "m", createdBy: "user", notification: { summary: "x" } }, "other"],
  ["a system message", { id: "m", createdBy: "system" }, "other"],
  ["no message found", undefined, "other"],
];

it.each(table)("turn origin: %s", (_name, message, origin) => {
  expect(turnOriginOf(message as Message | undefined)).toBe(origin);
});
