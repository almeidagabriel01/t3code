import type { EnvironmentId, MemoryItem, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AssistantMemoryList } from "./AssistantWorkMemory";

// Editing and forgetting are the Settings → Memory components, tested there; here they are seams.
vi.mock("../settings/MemorySettings", () => ({
  MemoryEditor: (props: {
    item?: { memoryId: string };
    scopeLabel?: string;
    onClose: () => void;
  }) => (
    <div>
      <span>{`Editing ${props.item?.memoryId} in ${props.scopeLabel}`}</span>
      <button type="button" onClick={props.onClose}>
        Close editor
      </button>
    </div>
  ),
  MemoryForgetControl: (props: { item: { memoryId: string } | null; label?: string }) => (
    <button type="button">{`${props.label} ${props.item?.memoryId}`}</button>
  ),
}));

const environmentId = "environment-local" as EnvironmentId;
const memory = (memoryId: string, text: string, scope: unknown, threadId: string | null) => ({
  item: {
    memoryId,
    memorySpaceId: "space-1",
    status: "active",
    scope,
    payload: { text, evidence: [] },
  } as unknown as Extract<MemoryItem, { status: "active" }>,
  sourceThreadId: threadId as ThreadId | null,
});

it("shows each memory with its scope and source, and opens the editor in place", async () => {
  const onNavigate = vi.fn();
  await using _screen = await render(
    <AssistantMemoryList
      environmentId={environmentId}
      assistant={{ projectId: "project-1" as ProjectId }}
      memories={[
        memory("m1", "Prefers short answers", { kind: "user" }, "assistant:ada:1"),
        memory("m2", "Uses pnpm here", { kind: "project" }, null),
      ]}
      onNavigate={onNavigate}
    />,
    { router: "/" },
  );
  await expect.element(page.getByText("Prefers short answers")).toBeVisible();
  await expect.element(page.getByText("User", { exact: true })).toBeVisible();
  // A project memory names its project, and one with no thread source has no link.
  await expect.element(page.getByText("Project", { exact: true })).toBeVisible();
  expect(page.getByRole("link", { name: "From a conversation" }).elements()).toHaveLength(1);
  await expect.element(page.getByRole("button", { name: "Forget m1" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Forget m2" })).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Edit memory" }).first());
  await expect.element(page.getByText("Editing m1 in User")).toBeVisible();
  expect(page.getByText("Prefers short answers").query()).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Close editor" }));
  await expect.element(page.getByText("Prefers short answers")).toBeVisible();

  await userEvent.click(page.getByRole("link", { name: "From a conversation" }));
  expect(onNavigate).toHaveBeenCalledOnce();
});
