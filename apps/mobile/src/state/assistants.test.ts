import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({ mocks: { query: vi.fn() } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: vi.fn() }));
vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const { Layer } = await import("effect");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()) };
});
vi.mock("./session", () => ({ environmentSession: {}, sessionHasScope: () => false }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("./query", () => ({ useEnvironmentQuery: mocks.query }));

import { useAtomValue } from "@effect/atom-react";

import { useAtomCommand } from "./use-atom-command";
import {
  useAssistantGroupActions,
  useAssistantGroupChat,
  useAssistantSandbox,
  useAssistantSandboxActions,
  useAssistantSpend,
} from "./assistants";

describe("useAssistantSpend", () => {
  it("stays idle without an assistant and queries its spend otherwise", () => {
    useAssistantSpend("hub" as never, null);
    expect(mocks.query).toHaveBeenLastCalledWith(null);
    useAssistantSpend("hub" as never, "a1" as never);
    expect(mocks.query.mock.calls.at(-1)?.[0]).not.toBeNull();
  });
});

describe("sandbox hooks", () => {
  it("reads the sandbox status atom and answers null before the first report", () => {
    vi.mocked(useAtomValue).mockReturnValueOnce({ state: "running" });
    expect(useAssistantSandbox("hub" as never)).toEqual({ state: "running" });
  });

  it("settles each action into a reply and sends the remove choice", async () => {
    const start = vi.fn().mockResolvedValue({ _tag: "Success", value: { state: "running" } });
    const stop = vi
      .fn()
      .mockResolvedValue({ _tag: "Failure", cause: Cause.fail({ message: "Docker said no" }) });
    const remove = vi.fn().mockResolvedValue({ _tag: "Success", value: { state: "not_created" } });
    vi.mocked(useAtomCommand)
      .mockReturnValueOnce(start as never)
      .mockReturnValueOnce(stop as never)
      .mockReturnValueOnce(remove as never);
    vi.mocked(useAtomValue).mockReturnValueOnce(true);
    const actions = useAssistantSandboxActions("hub" as never);
    expect(actions.canAct).toBe(true);
    expect(await actions.start()).toEqual({ ok: true, value: { state: "running" } });
    expect(start).toHaveBeenCalledWith({ environmentId: "hub", input: {} });
    expect(await actions.stop()).toEqual({ ok: false, message: "Docker said no" });
    await actions.remove(true);
    expect(remove).toHaveBeenCalledWith({ environmentId: "hub", input: { deleteVolumes: true } });
  });
});

describe("group chat hooks", () => {
  it("reads the chat's live state, null before the first snapshot", () => {
    const state = { messages: new Map(), tasks: new Map(), hasMore: false };
    vi.mocked(useAtomValue).mockReturnValueOnce(AsyncResult.success(state));
    expect(useAssistantGroupChat("hub" as never, "g1" as never)).toBe(state);
    vi.mocked(useAtomValue).mockReturnValueOnce(AsyncResult.initial());
    expect(useAssistantGroupChat("hub" as never, "g1" as never)).toBeNull();
  });

  const commands = () => {
    const post = vi.fn();
    const taskAction = vi.fn();
    const history = vi.fn();
    vi.mocked(useAtomCommand)
      .mockReturnValueOnce(post as never)
      .mockReturnValueOnce(taskAction as never)
      .mockReturnValueOnce(history as never);
    vi.mocked(useAtomValue).mockReturnValueOnce(true).mockReturnValueOnce(false);
    return { post, taskAction, history, actions: useAssistantGroupActions("hub" as never) };
  };

  it("posts, and hands back the refusal's reason", async () => {
    const { post, actions } = commands();
    expect([actions.canPost, actions.canAct]).toEqual([true, false]);
    post.mockResolvedValueOnce({ _tag: "Success", value: { message: { id: "m1" }, tasks: [] } });
    expect(await actions.post({ teamId: "g1", text: "hi" } as never)).toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledWith({
      environmentId: "hub",
      input: { teamId: "g1", text: "hi" },
    });
    post.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail({ message: "needs a mention", reason: "mention_required" }),
    });
    expect(await actions.post({ teamId: "g1", text: "hi" } as never)).toEqual({
      ok: false,
      message: "needs a mention",
      reason: "mention_required",
    });
    post.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail({ message: "boom" }) });
    expect(await actions.post({ teamId: "g1", text: "hi" } as never)).toMatchObject({
      ok: false,
      reason: null,
    });
  });

  it("settles task actions into replies", async () => {
    const { taskAction, actions } = commands();
    taskAction.mockResolvedValueOnce({ _tag: "Success", value: { id: "t1" } });
    expect(await actions.taskAction({ taskId: "t1", action: "stop" } as never)).toEqual({
      ok: true,
      value: { id: "t1" },
    });
    taskAction.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail({ message: "late" }) });
    expect(await actions.taskAction({ taskId: "t1", action: "stop" } as never)).toEqual({
      ok: false,
      message: "late",
    });
  });

  it("pages before the oldest loaded message, or loads the newest page from an empty chat", async () => {
    const { history, actions } = commands();
    history.mockResolvedValue({
      _tag: "Success",
      value: { messages: [], tasks: [], hasMore: false },
    });
    const state = {
      messages: new Map([
        ["a", { seq: 7 }],
        ["b", { seq: 4 }],
      ]),
      tasks: new Map(),
      hasMore: true,
    };
    await actions.olderThan("g1" as never, state as never);
    expect(history).toHaveBeenLastCalledWith({
      environmentId: "hub",
      input: { teamId: "g1", beforeSeq: 4 },
    });
    await actions.olderThan("g1" as never, { ...state, messages: new Map() } as never);
    expect(history).toHaveBeenLastCalledWith({ environmentId: "hub", input: { teamId: "g1" } });
    history.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail({ message: "gone" }) });
    expect(await actions.olderThan("g1" as never, state as never)).toEqual({
      ok: false,
      message: "gone",
    });
  });
});
