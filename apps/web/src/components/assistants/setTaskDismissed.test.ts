import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ reply: vi.fn(), toast: vi.fn() }));

vi.mock("../../state/assistants", () => ({ setAssistantTaskDismissed: mocks.reply }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { setTaskDismissed } from "./useAssistantFlows";

const environmentId = EnvironmentId.make("desk");
const threadId = ThreadId.make("task-thread");

describe("setTaskDismissed", () => {
  beforeEach(() => {
    mocks.reply.mockReset();
    mocks.toast.mockReset();
  });

  it.each([
    [true, "Could not dismiss the task"],
    [false, "Could not restore the task"],
  ])("toasts a refusal when dismissed is %s", async (dismissed, title) => {
    mocks.reply.mockResolvedValue({ ok: false, message: "Task is still running" });
    await setTaskDismissed(environmentId, threadId, dismissed);
    expect(mocks.reply).toHaveBeenCalledWith(environmentId, threadId, dismissed);
    expect(mocks.toast).toHaveBeenCalledWith({
      type: "error",
      title,
      description: "Task is still running",
    });
  });

  it("stays quiet when the server accepts", async () => {
    mocks.reply.mockResolvedValue({ ok: true, value: undefined });
    await setTaskDismissed(environmentId, threadId, true);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
