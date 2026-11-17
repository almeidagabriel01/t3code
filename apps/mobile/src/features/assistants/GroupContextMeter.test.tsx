import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  refresh: vi.fn(),
  usage: new Map<string, unknown>(),
  state: {
    messages: new Map([["reply-1", { requestId: "req-1" }]]),
  },
}));

vi.mock("@t3tools/client-runtime/assistantGroupChat", () => ({
  assistantGroupComposerSession: mocks.session,
}));
vi.mock("../../state/assistants", () => ({
  useAssistantGroupChat: () => mocks.state,
  useAssistantGroupSendContext: () => "context",
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { threadContextUsage: (args: unknown) => args },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (args: { input: { threadId: string } }) => ({
    data: mocks.usage.get(args.input.threadId) ?? null,
    refresh: mocks.refresh,
  }),
}));
vi.mock("../threads/ComposerContextMeter", () => ({
  ComposerContextMeter: (props: { usage: { usedTokens: number }; title: string }) => (
    <span data-title={props.title}>{props.usage.usedTokens}</span>
  ),
}));

const { GroupContextMeter } = await import("./GroupContextMeter");

const ada = { id: "ada", name: "Ada" };

function mount(node: ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    rerender: (next: ReactNode) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}

const meter = (reply: { id: string } | null) => (
  <GroupContextMeter
    environmentId={"hub" as never}
    chat={{ teamId: "team" as never, scope: undefined, reply: reply as never }}
    text="@ada go on"
    members={[ada] as never}
    leadId={"jarvis" as never}
  />
);

it("reads the context of the member a reply lands with, in that request's thread", () => {
  mocks.session.mockReturnValue({ ownerId: "ada", threadId: "thread-ada" });
  mocks.usage.set("thread-ada", {
    latestTurnUsage: { usedTokens: 42_000, maxTokens: 200_000, updatedAt: "2026-11-16T00:00:00Z" },
    providerThread: null,
  });
  const view = mount(meter({ id: "reply-1" }));
  expect(mocks.session).toHaveBeenLastCalledWith({
    state: mocks.state,
    requestId: "req-1",
    text: "@ada go on",
    members: [ada],
    leadId: "jarvis",
    context: "context",
  });
  const label = view.container.querySelector("span")!;
  expect(label.getAttribute("data-title")).toBe("Context of Ada in this request");
  expect(label.textContent).toBe("42000");
  view.unmount();
});

it("names a member who left the group, and hides until the server reports usage", () => {
  mocks.session.mockReturnValue({ ownerId: "gone", threadId: "thread-gone" });
  mocks.usage.delete("thread-gone");
  let view = mount(meter({ id: "reply-1" }));
  expect(view.container.innerHTML).toBe("");
  view.unmount();

  mocks.usage.set("thread-gone", {
    latestTurnUsage: { usedTokens: 1_000, maxTokens: 100_000, updatedAt: "2026-11-16T00:00:00Z" },
    providerThread: null,
  });
  view = mount(meter({ id: "reply-1" }));
  expect(view.container.querySelector("span")!.getAttribute("data-title")).toBe(
    "Context of Removed member in this request",
  );
  view.unmount();
});

it("shows nothing for a new request, which opens fresh threads", () => {
  mocks.session.mockReturnValue(null);
  const view = mount(meter(null));
  expect(mocks.session).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: null }));
  expect(view.container.innerHTML).toBe("");
  view.unmount();
});

it("asks the server again only once the session's task changes", () => {
  mocks.refresh.mockClear();
  mocks.session.mockReturnValue({ ownerId: "ada", threadId: "thread-ada", updatedAt: "1" });
  const view = mount(meter({ id: "reply-1" }));
  view.rerender(meter({ id: "reply-1" }));
  expect(mocks.refresh).not.toHaveBeenCalled();
  mocks.session.mockReturnValue({ ownerId: "ada", threadId: "thread-ada", updatedAt: "2" });
  view.rerender(meter({ id: "reply-1" }));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  view.unmount();
});
