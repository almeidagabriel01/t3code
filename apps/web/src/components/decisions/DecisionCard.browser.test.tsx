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
