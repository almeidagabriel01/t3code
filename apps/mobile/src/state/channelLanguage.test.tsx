import type { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  settings: null as null | { channelLanguage: string },
  update: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.settings }));
vi.mock("./server", () => ({
  serverEnvironment: { settingsValueAtom: () => ({}), updateSettings: {} },
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => mocks.update }));

import { useChannelLanguage } from "./channelLanguage";

async function read() {
  let seen: ReturnType<typeof useChannelLanguage> | undefined;
  function Probe() {
    seen = useChannelLanguage("env" as EnvironmentId);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  await act(async () => root.unmount());
  return seen!;
}

describe("useChannelLanguage", () => {
  it("reads the server setting, defaulting to automatic before settings arrive", async () => {
    mocks.settings = { channelLanguage: "pt-BR" };
    expect((await read()).language).toBe("pt-BR");
    mocks.settings = null;
    expect((await read()).language).toBe("auto");
  });

  it("patches only the language on the environment", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.update.mockClear();
    await (await read()).set("en");
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env",
      input: { patch: { channelLanguage: "en" } },
    });
  });
});
