import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    environmentIds: ["env"] as string[],
    scratchRoot: "/scratch" as string | null,
    openScratch: vi.fn(),
    select: vi.fn(),
    loaded: vi.fn(),
    createDraft: vi.fn(),
    setText: vi.fn(),
    interrupted: false,
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => mocks.interrupted,
  squashAtomCommandFailure: (result: { failure: unknown }) => result.failure,
}));
vi.mock("../../state/assistants", () => ({
  useAssistantsEnvironmentIds: () => mocks.environmentIds,
}));
vi.mock("../../state/entities", () => ({
  useServerConfigs: () => ({ get: () => ({ scratchWorkspaceRoot: mocks.scratchRoot }) }),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { openScratch: "openScratch" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.openScratch }));
vi.mock("../../state/use-composer-drafts", () => ({
  createNewTaskDraft: (...args: unknown[]) => mocks.createDraft(...args),
  setComposerDraftText: (...args: unknown[]) => mocks.setText(...args),
  waitForComposerDraftsLoaded: () => mocks.loaded(),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.select,
}));

import { describeAssistantPrompt, useStartDescribeAssistant } from "./describeAssistant";

let root: Root;
let start: (description: string) => Promise<string | null>;
const capture = (next: typeof start) => {
  start = next;
};
function Probe(props: { readonly onStart: typeof capture }): ReactNode {
  props.onStart(useStartDescribeAssistant());
  return null;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(window.document.createElement("div"));
  Object.assign(mocks, { environmentIds: ["env"], scratchRoot: "/scratch", interrupted: false });
  for (const fn of [
    mocks.openScratch,
    mocks.select,
    mocks.loaded,
    mocks.createDraft,
    mocks.setText,
  ]) {
    fn.mockReset();
  }
  mocks.openScratch.mockResolvedValue({ _tag: "Success", value: { id: "scratch1" } });
  mocks.loaded.mockResolvedValue(undefined);
  mocks.createDraft.mockReturnValue("draft1");
  await act(async () => root.render(<Probe onStart={capture} />));
});
afterEach(() => act(() => root.unmount()));

describe("describeAssistantPrompt", () => {
  it("matches the text web sends, with the description trimmed", () => {
    expect(describeAssistantPrompt("  a reviewer \n")).toBe(
      "Create this with the t3_assistant tool. If I did not say the access level, ask me whether I want the default (up to your level) or a custom setup before creating it.\n\na reviewer",
    );
  });
});

describe("useStartDescribeAssistant", () => {
  it("opens a Scratch draft with the prompt ready to send", async () => {
    expect(await start("a reviewer")).toBeNull();
    expect(mocks.createDraft).toHaveBeenCalledWith({ environmentId: "env", projectId: "scratch1" });
    expect(mocks.setText).toHaveBeenCalledWith("draft1", describeAssistantPrompt("a reviewer"));
    expect(mocks.select).toHaveBeenCalledWith({
      name: "Thread",
      params: {
        draft: {
          environmentId: "env",
          projectId: "scratch1",
          title: "New assistant",
          draftId: "draft1",
        },
      },
    });
  });

  it("says so when no environment has a Scratch project", async () => {
    mocks.scratchRoot = null;
    await act(async () => root.render(<Probe key="a" onStart={capture} />));
    expect(await start("x")).toBe("No Scratch project is available here.");
    mocks.scratchRoot = "/scratch";
    mocks.environmentIds = [];
    await act(async () => root.render(<Probe key="b" onStart={capture} />));
    expect(await start("x")).toBe("No Scratch project is available here.");
    expect(mocks.openScratch).not.toHaveBeenCalled();
  });

  it.each([
    ["an error", { _tag: "Failure", failure: new Error("Disk full.") }, false, "Disk full."],
    ["something odd", { _tag: "Failure", failure: "x" }, false, "Could not open a thread."],
    ["an interruption", { _tag: "Failure", failure: "x" }, true, null],
  ])("handles Scratch failing with %s", async (_name, result, interrupted, message) => {
    mocks.openScratch.mockResolvedValue(result);
    mocks.interrupted = interrupted;
    expect(await start("x")).toBe(message);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("does not open a thread when drafts cannot load", async () => {
    mocks.loaded.mockRejectedValue(new Error("no"));
    expect(await start("x")).toBe("Drafts could not be loaded.");
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
