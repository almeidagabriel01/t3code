import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const testState = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock(import("~/state/use-orchestration-command"), async (original) => ({
  ...(await original()),
  useOrchestrationCommand: (() => testState.update) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() => new Map()) as never,
  useProjects: (() => []) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  readEnvironment: (() => ({ connection: { phase: "connected" }, serverConfig: {} })) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => true) as never,
  useEnvironmentsWithScope: (() => new Set()) as never,
}));

import { useProjectPin } from "./useProjectGroupUpdate";

function Probe(props: { archived: boolean }) {
  const { toggleProjectGroupArchive } = useProjectPin();
  return (
    <button
      onClick={() =>
        void toggleProjectGroupArchive({
          archived: props.archived,
          memberProjects: [{ environmentId: "env" as never, id: "p1" as never }],
        })
      }
    >
      toggle
    </button>
  );
}

describe("toggleProjectGroupArchive", () => {
  it.each([true, false])("writes archived=%s's opposite to every member", async (archived) => {
    testState.update.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    await using screen = await render(<Probe archived={archived} />, { router: false });
    screen.getByRole("button").element().click();
    await vi.waitFor(() =>
      expect(testState.update).toHaveBeenCalledWith({
        environmentId: "env",
        input: { projectId: "p1", archived: !archived },
      }),
    );
  });
});
