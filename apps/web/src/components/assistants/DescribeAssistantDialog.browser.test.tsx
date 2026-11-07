import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DescribeAssistantDialog, describeAssistantPrompt } from "./DescribeAssistantDialog";

const state = vi.hoisted(() => ({
  environmentId: "env" as string | null,
  project: { environmentId: "env", id: "scratch" } as { environmentId: string; id: string } | null,
  opened: { draftId: "d1", threadId: "t1" } as { draftId: string; threadId: string } | null,
  newThread: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => state.environmentId,
    openScratchProject: async () => state.project,
  }),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => state.newThread,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));

function setup(
  overrides: Partial<Pick<typeof state, "environmentId" | "project" | "opened">> = {},
) {
  state.environmentId = "env";
  state.project = { environmentId: "env", id: "scratch" };
  state.opened = { draftId: "d1", threadId: "t1" };
  Object.assign(state, overrides);
  state.newThread.mockReset();
  state.newThread.mockImplementation(async () => state.opened);
  state.toast.mockClear();
}

async function describeIt() {
  await userEvent.type(
    page.getByRole("textbox", { name: "What should it do?" }),
    "A reviewer for pull requests",
  );
  (page.getByRole("button", { name: "Start" }).element() as HTMLElement).click();
}

describe("DescribeAssistantDialog", () => {
  it("opens a Scratch thread whose composer holds the request, then closes", async () => {
    setup();
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <DescribeAssistantDialog open onOpenChange={onOpenChange} />,
    );
    await expect.element(page.getByRole("button", { name: "Start" })).toBeDisabled();
    await describeIt();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(state.newThread).toHaveBeenCalledWith(
      { environmentId: "env", projectId: "scratch" },
      { prompt: describeAssistantPrompt("A reviewer for pull requests") },
    );
    expect(describeAssistantPrompt(" x ")).toMatch(/^Create this with the t3_assistant tool\./);
    expect(describeAssistantPrompt(" x ")).toMatch(/\n\nx$/);
  });

  it.each([
    { name: "no machine offers Scratch", overrides: { environmentId: null }, title: "No Scratch" },
    { name: "Scratch cannot open", overrides: { project: null }, title: "No Scratch" },
    { name: "the thread cannot open", overrides: { opened: null }, title: "Could not open" },
  ])("keeps the dialog and says so when $name", async ({ overrides, title }) => {
    setup(overrides);
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <DescribeAssistantDialog open onOpenChange={onOpenChange} />,
    );
    await describeIt();
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: expect.stringContaining(title) }),
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("cancels", async () => {
    setup();
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <DescribeAssistantDialog open onOpenChange={onOpenChange} />,
    );
    (page.getByRole("button", { name: "Cancel" }).element() as HTMLElement).click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
