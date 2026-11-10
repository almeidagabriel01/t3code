import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Exit from "effect/Exit";
import { describe, expect, it, vi } from "vite-plus/test";

const run = vi.hoisted(() => vi.fn());

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./server", () => ({ environmentServerConfigsAtom: Atom.make(new Map()) }));
vi.mock("./session", () => ({ useEnvironmentsWithScope: () => new Set() }));
vi.mock("./query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/assistants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/assistants")>()),
  createAssistantsEnvironmentAtoms: () => ({
    live: () => Atom.make(AsyncResult.initial()),
    setTaskDismissed: { label: "setTaskDismissed", run },
  }),
}));

import { readAssistantTask, setAssistantTaskDismissed } from "./assistants";

const environmentId = EnvironmentId.make("desk");
const threadId = ThreadId.make("task-thread");

describe("assistant task dismissal", () => {
  it("sends the choice to the environment and reports success", async () => {
    run.mockResolvedValue(Exit.succeed(undefined));
    await expect(setAssistantTaskDismissed(environmentId, threadId, true)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(run).toHaveBeenCalledWith(expect.anything(), {
      environmentId,
      input: { threadId, dismissed: true },
    });
  });

  it("turns a refusal into a message", async () => {
    run.mockResolvedValue(Exit.fail({ message: "Task is still running" }));
    const reply = await setAssistantTaskDismissed(environmentId, threadId, false);
    expect(reply.ok).toBe(false);
  });

  it("reads no task for a thread no assistant launched", () => {
    expect(readAssistantTask(environmentId, threadId)).toBeNull();
  });
});
