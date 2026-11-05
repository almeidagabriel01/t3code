import type { Decision, DecisionId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DecisionCard } from "./DecisionCard";

const open: Decision = {
  id: "d1" as DecisionId,
  fromThreadId: "t1" as ThreadId,
  threadTitle: "Nightly migration",
  title: "Pick a migration strategy",
  context: "Two ways to do it.",
  options: [
    { id: "online", label: "Online", consequence: "Slower, no downtime" },
    { id: "offline", label: "Offline" },
  ],
  recommended: "online",
  status: "open",
  createdAt: "2026-10-01T00:00:00.000Z",
};

const ok = () => Promise.resolve({ ok: true as const });

it("answers with the chosen option and any note", async () => {
  const onAnswer = vi.fn(ok);
  await using _screen = await render(
    <DecisionCard decision={open} canAct onAnswer={onAnswer} onDismiss={ok} />,
    { router: false }, // no navigation in the card
  );
  await expect.element(page.getByText("Recommended")).toBeVisible();
  await expect.element(page.getByText("Slower, no downtime")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Answer" })).toBeDisabled();

  await userEvent.click(page.getByText("Offline"));
  await userEvent.click(page.getByText("Other answer or add a note"));
  await userEvent.type(page.getByLabelText("Other answer or note"), "after the release");
  await userEvent.click(page.getByRole("button", { name: "Answer" }));
  expect(onAnswer).toHaveBeenCalledWith({ optionId: "offline", text: "after the release" });
});

it("accepts free text alone", async () => {
  const onAnswer = vi.fn(ok);
  await using _screen = await render(
    <DecisionCard decision={open} canAct onAnswer={onAnswer} onDismiss={ok} />,
    { router: false }, // no navigation in the card
  );
  await userEvent.click(page.getByText("Other answer or add a note"));
  await userEvent.type(page.getByLabelText("Other answer or note"), "Neither");
  await userEvent.click(page.getByRole("button", { name: "Answer" }));
  expect(onAnswer).toHaveBeenCalledWith({ text: "Neither" });
});

it("dismisses without choosing, and shows a refusal inline", async () => {
  const onDismiss = vi.fn(() =>
    Promise.resolve({ ok: false as const, message: "Already expired." }),
  );
  await using _screen = await render(
    <DecisionCard decision={open} canAct onAnswer={ok} onDismiss={onDismiss} />,
    { router: false }, // no navigation in the card
  );
  await userEvent.click(page.getByRole("button", { name: "Dismiss" }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  await expect.element(page.getByRole("alert")).toHaveTextContent("Already expired.");
});

it("an assistant's notice only offers to acknowledge it", async () => {
  const onDismiss = vi.fn(ok);
  await using _screen = await render(
    <DecisionCard
      decision={{ ...open, notice: true, options: [{ id: "ok", label: "Got it" }] }}
      canAct
      onAnswer={ok}
      onDismiss={onDismiss}
    />,
    { router: false }, // no navigation in the card
  );
  await expect.element(page.getByText("Two ways to do it.")).toBeVisible();
  expect(page.getByRole("button", { name: "Answer" }).elements()).toHaveLength(0);
  expect(page.getByText("Other answer or add a note").elements()).toHaveLength(0);
  await userEvent.click(page.getByRole("button", { name: "Got it" }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("reads a settled decision without controls", async () => {
  await using _screen = await render(
    <DecisionCard
      decision={{ ...open, status: "answered", answer: { optionId: "online" } }}
      canAct
      onAnswer={ok}
      onDismiss={ok}
    />,
    { router: false }, // no navigation in the card
  );
  await expect.element(page.getByText("Answered")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Answer" })).not.toBeInTheDocument();
});

it("attaches files alone, waits for uploads, and hides attaching for approvals", async () => {
  const onAnswer = vi.fn(ok);
  let finish: (value: { attachmentId: string; mimeType: string }) => void = () => {};
  const onUploadFile = vi.fn(
    () =>
      new Promise<{ attachmentId: string; mimeType: string }>((resolve) => {
        finish = resolve;
      }),
  );
  await using _screen = await render(
    <DecisionCard
      decision={open}
      canAct
      onAnswer={onAnswer}
      onDismiss={ok}
      onUploadFile={onUploadFile}
    />,
    { router: false }, // no navigation in the card
  );
  await userEvent.upload(
    page.getByLabelText("Choose files to attach"),
    new File(["x"], "plan.pdf", { type: "application/pdf" }),
  );
  await expect.element(page.getByText("plan.pdf")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Answer" })).toBeDisabled();

  finish({ attachmentId: "pending-1", mimeType: "application/pdf" });
  await expect.element(page.getByRole("button", { name: "Answer" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "Answer" }));
  expect(onAnswer).toHaveBeenCalledWith({
    attachments: [
      {
        type: "file",
        id: "pending-1",
        name: "plan.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
      },
    ],
  });
});

it("deletes a file removed before answering, even one still uploading", async () => {
  const onDiscardFile = vi.fn();
  let finishSlow: (value: { attachmentId: string; mimeType: string }) => void = () => {};
  const onUploadFile = vi.fn((file: File) =>
    file.name === "fast.txt"
      ? Promise.resolve({ attachmentId: "pending-fast", mimeType: "text/plain" })
      : new Promise<{ attachmentId: string; mimeType: string }>((resolve) => {
          finishSlow = resolve;
        }),
  );
  await using _screen = await render(
    <DecisionCard
      decision={open}
      canAct
      onAnswer={ok}
      onDismiss={ok}
      onUploadFile={onUploadFile}
      onDiscardFile={onDiscardFile}
    />,
    { router: false }, // no navigation in the card
  );
  await userEvent.upload(page.getByLabelText("Choose files to attach"), [
    new File(["x"], "fast.txt", { type: "text/plain" }),
    new File(["y"], "slow.txt", { type: "text/plain" }),
  ]);
  await expect.element(page.getByRole("button", { name: "Remove fast.txt" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Remove fast.txt" }));
  expect(onDiscardFile).toHaveBeenCalledWith("pending-fast");

  await userEvent.click(page.getByRole("button", { name: "Remove slow.txt" }));
  expect(onDiscardFile).toHaveBeenCalledTimes(1);
  finishSlow({ attachmentId: "pending-slow", mimeType: "text/plain" });
  await vi.waitFor(() => expect(onDiscardFile).toHaveBeenLastCalledWith("pending-slow"));
  await expect.element(page.getByText("slow.txt")).not.toBeInTheDocument();
});

it("keeps a failed upload out of the answer and lets it be removed", async () => {
  await using _screen = await render(
    <DecisionCard
      decision={open}
      canAct
      onAnswer={ok}
      onDismiss={ok}
      onUploadFile={() => Promise.reject(new Error("Too big"))}
    />,
    { router: false }, // no navigation in the card
  );
  await userEvent.upload(
    page.getByLabelText("Choose files to attach"),
    new File(["x"], "huge.bin", { type: "application/octet-stream" }),
  );
  await expect.element(page.getByText("huge.bin (upload failed)")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Answer" })).toBeDisabled();
  await userEvent.click(page.getByRole("button", { name: "Remove huge.bin" }));
  await expect.element(page.getByText("huge.bin (upload failed)")).not.toBeInTheDocument();
});

it("offers no attach button on an approval decision, and names files once answered", async () => {
  await using _screen = await render(
    <DecisionCard
      decision={{ ...open, approvalRequestId: "r1" }}
      canAct
      onAnswer={ok}
      onDismiss={ok}
      onUploadFile={() => Promise.reject(new Error("unused"))}
    />,
    { router: false }, // no navigation in the card
  );
  await expect.element(page.getByText("Attach files")).not.toBeInTheDocument();
});

it("shows attachment names on an answered decision", async () => {
  await using _screen = await render(
    <DecisionCard
      decision={{
        ...open,
        status: "answered",
        answer: {
          attachments: [
            {
              type: "file",
              id: "a" as never,
              name: "plan.pdf",
              mimeType: "application/pdf",
              sizeBytes: 1,
            },
          ],
        },
      }}
      canAct
      onAnswer={ok}
      onDismiss={ok}
    />,
    { router: false }, // no navigation in the card
  );
  await expect.element(page.getByText(/plan\.pdf/)).toBeVisible();
});
