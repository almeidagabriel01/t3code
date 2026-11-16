import type { NeedsYouItem } from "@t3tools/client-runtime/sidebarZones";
import type { Decision } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "../../index.css";

import { render } from "../../../test/render";
import { useDecisionActions } from "../../state/decisions";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails } from "../../state/threads";
import { NeedsYouSection } from "./NeedsYouSection";

const state = vi.hoisted(() => ({
  requests: {} as Record<string, unknown>,
  respondToApproval: vi.fn(),
  respondToUserInput: vi.fn(),
  answerDecision: vi.fn(),
}));

// Commands are told apart by label, so the real thread module (and its imports) stays.
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label.endsWith("respond-to-approval")
      ? state.respondToApproval
      : command.label.endsWith("respond-to-user-input")
        ? state.respondToUserInput
        : vi.fn(),
}));
vi.mock("../../state/decisions", { spy: true });
vi.mock("../../state/entities", { spy: true });
vi.mock("../../state/session", { spy: true });

const AT = "2026-11-01T00:00:00.000Z";
const success = { _tag: "Success", value: undefined };

const requestAtoms = new Map<string, Atom.Atom<unknown>>();

function setup() {
  vi.spyOn(environmentThreadDetails, "pendingRequestsAtom").mockImplementation((ref) => {
    const value = state.requests[ref.threadId] ?? null;
    const key = `${ref.threadId}:${JSON.stringify(value)}`;
    if (!requestAtoms.has(key)) requestAtoms.set(key, Atom.make(value));
    return requestAtoms.get(key) as never;
  });
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  vi.mocked(useDecisionActions).mockReturnValue({
    canAct: true,
    answer: state.answerDecision,
    dismiss: vi.fn(),
  });
  vi.mocked(useQuietThreadShell).mockImplementation(
    (ref) => ({ title: `Thread ${ref?.threadId}`, projectId: "p1" }) as never,
  );
  state.requests = {};
  for (const mock of [state.respondToApproval, state.respondToUserInput, state.answerDecision]) {
    mock.mockReset();
  }
  state.respondToApproval.mockResolvedValue(success);
  state.respondToUserInput.mockResolvedValue(success);
  state.answerDecision.mockResolvedValue({ ok: true });
}

const request = (
  threadId: string,
  kind: "approval" | "question",
  owner: NeedsYouItem["owner"] = { kind: "project" },
): NeedsYouItem<Decision> => ({
  key: `request:env:req-${threadId}`,
  kind,
  environmentId: "env",
  threadId,
  createdAt: AT,
  owner,
  request: { id: `req-${threadId}`, kind: kind === "question" ? "user_input" : "command" },
});

const guest = (threadId: string): NeedsYouItem<Decision> => ({
  key: `guest:env:${threadId}`,
  kind: "guest",
  environmentId: "env",
  threadId,
  createdAt: AT,
  owner: { kind: "project" },
});

const decision = (threadId: string, options: number): NeedsYouItem<Decision> => ({
  key: `decision:env:d-${threadId}`,
  kind: "decision",
  environmentId: "env",
  threadId,
  createdAt: AT,
  owner: { kind: "project" },
  decision: {
    id: `d-${threadId}`,
    fromThreadId: threadId,
    threadTitle: "Ask",
    title: "Ship it?",
    context: "",
    options: Array.from({ length: options }, (_, index) => ({
      id: `o${index}`,
      label: `Option ${index}`,
    })),
    status: "open",
    createdAt: AT,
  } as never,
});

const approval = (threadId: string, responseCapability = "live") => ({
  approvals: [
    {
      requestId: `req-${threadId}`,
      requestKind: "command",
      createdAt: AT,
      detail: "rm -rf build",
      responseCapability,
    },
  ],
  userInputs: [],
});

const question = (
  threadId: string,
  questions: ReadonlyArray<{ options?: ReadonlyArray<{ label: string; value?: string }> }>,
) => ({
  approvals: [],
  userInputs: [
    {
      requestId: `req-${threadId}`,
      createdAt: AT,
      responseCapability: "live",
      dismissible: false,
      questions: questions.map((entry, index) => ({
        id: `q${index}`,
        header: "Pick",
        question: `Which one ${index}?`,
        options: (entry.options ?? []).map((option) => ({ description: "", ...option })),
        multiSelect: false,
      })),
    },
  ],
});

const Section = (props: {
  readonly items: ReadonlyArray<NeedsYouItem<Decision>>;
  readonly onOpenThread?: () => void;
}) => (
  <ul>
    <NeedsYouSection
      items={props.items}
      assistantByKey={
        new Map([
          [
            "env:ada",
            {
              environmentId: "env",
              assistant: { id: "ada", name: "Ada", avatar: null, icon: null },
            },
          ],
        ]) as never
      }
      teamNameByKey={new Map([["env:t1", "Growth"]])}
      projectOf={() =>
        ({
          environmentId: "env",
          title: "ProOps",
          workspaceRoot: "/p",
          faviconPath: null,
          projectIcon: { kind: "monogram", text: "PO", color: "green" },
        }) as never
      }
      onOpenThread={props.onOpenThread ?? vi.fn()}
    />
  </ul>
);

const cards = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="needs-you-item"]')].map((card) =>
    card.getAttribute("data-kind"),
  );

describe("NeedsYouSection", () => {
  it("renders nothing while nothing waits", async () => {
    setup();
    await using screen = await render(<Section items={[]} />);
    expect(screen.container.textContent).toBe("");
  });

  it("lists one card per approval, question, decision and waiting guest, oldest first, with their origin", async () => {
    setup();
    state.requests = { t1: approval("t1"), t2: question("t2", [{}]) };
    const onOpenThread = vi.fn();
    await using screen = await render(
      <Section
        onOpenThread={onOpenThread}
        items={[
          request("t1", "approval", { kind: "assistant", assistantKey: "env:ada", teamKey: null }),
          request("t2", "question", {
            kind: "assistant",
            assistantKey: "env:ada",
            teamKey: "env:t1",
          }),
          decision("t3", 2),
          guest("t4"),
        ]}
      />,
    );
    expect(cards(screen.container)).toEqual(["approval", "question", "decision", "guest"]);
    expect(screen.getByTestId("sidebar-needs-you-header").element().textContent).toBe("Needs you4");
    const lines = [...screen.container.querySelectorAll('[data-testid="needs-you-item"]')].map(
      (card) => card.textContent,
    );
    expect(lines[0]).toContain("Ada· ProOps");
    expect(lines[0]).toContain("rm -rf build");
    expect(lines[1]).toContain("Growth· ProOps");
    expect(lines[1]).toContain("Which one 0?");
    expect(lines[2]).toContain("Thread t3· ProOps");
    expect(lines[2]).toContain("Ship it?");
    // The guest's messages are sent or dismissed in the thread, so its card only opens it.
    expect(lines[3]).toContain("Thread t4· ProOps");
    expect(lines[3]).toContain("Guest waiting");
    const guestCard = screen.container.querySelector('[data-kind="guest"]') as HTMLElement;
    expect([...guestCard.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Open",
    ]);
    await userEvent.click(guestCard.querySelector("button")!);
    expect(onOpenThread).toHaveBeenCalledWith({ environmentId: "env", threadId: "t4" });
  });

  it("approves and denies with the request's id", async () => {
    setup();
    state.requests = { t1: approval("t1") };
    await using screen = await render(<Section items={[request("t1", "approval")]} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(state.respondToApproval.mock.calls.map(([call]) => call)).toEqual([
      { environmentId: "env", input: { threadId: "t1", requestId: "req-t1", decision: "accept" } },
      { environmentId: "env", input: { threadId: "t1", requestId: "req-t1", decision: "decline" } },
    ]);
  });

  it("answers a single question with an option or typed text", async () => {
    setup();
    state.requests = {
      t1: question("t1", [{ options: [{ label: "Yes", value: "y" }, { label: "No" }] }]),
      t2: question("t2", [{}]),
    };
    await using screen = await render(
      <Section items={[request("t1", "question"), request("t2", "question")]} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Yes" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Answer: Which one 0?" }), "Blue");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(state.respondToUserInput.mock.calls.map(([call]) => call)).toEqual([
      {
        environmentId: "env",
        input: { threadId: "t1", requestId: "req-t1", answers: { q0: "y" } },
      },
      {
        environmentId: "env",
        input: { threadId: "t2", requestId: "req-t2", answers: { q0: "Blue" } },
      },
    ]);
  });

  it.each([
    { name: "several questions", requests: question("t1", [{}, {}]) },
    {
      name: "a request the provider can no longer answer",
      requests: approval("t1", "not_resumable"),
    },
    { name: "a request whose detail has not loaded", requests: undefined },
  ])("offers only Open for $name", async ({ requests }) => {
    setup();
    if (requests !== undefined) state.requests = { t1: requests };
    const kind = requests?.userInputs.length ? "question" : "approval";
    await using screen = await render(<Section items={[request("t1", kind)]} />);
    const card = screen.container.querySelector('[data-testid="needs-you-item"]')!;
    expect([...card.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Open",
    ]);
  });

  it("answers a decision with the option's id, three options at most, and opens its thread", async () => {
    setup();
    const onOpenThread = vi.fn();
    await using screen = await render(
      <Section items={[decision("t3", 5)]} onOpenThread={onOpenThread} />,
    );
    const card = screen.container.querySelector('[data-testid="needs-you-item"]')!;
    expect([...card.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Option 0",
      "Option 1",
      "Option 2",
      "Open",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Option 1" }));
    expect(state.answerDecision).toHaveBeenCalledWith("d-t3", { optionId: "o1" });
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenThread).toHaveBeenCalledWith({ environmentId: "env", threadId: "t3" });
  });

  it("keeps the card and shows the error when an answer fails", async () => {
    setup();
    state.requests = { t1: approval("t1") };
    state.respondToApproval.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Provider went away")),
    });
    await using screen = await render(<Section items={[request("t1", "approval")]} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Provider went away");
    expect(cards(screen.container)).toEqual(["approval"]);
  });

  it("shows five cards until Show N more is pressed", async () => {
    setup();
    const items = Array.from({ length: 7 }, (_, index) => decision(`t${index}`, 1));
    await using screen = await render(<Section items={items} />);
    expect(cards(screen.container)).toHaveLength(5);
    await userEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(cards(screen.container)).toHaveLength(7);
  });
});
