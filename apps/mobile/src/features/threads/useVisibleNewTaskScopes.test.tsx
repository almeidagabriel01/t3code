import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ preferences: null as unknown }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.preferences }));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));

import { useVisibleNewTaskScopes } from "./useVisibleNewTaskScopes";

const scope = (id: string, title: string) =>
  ({
    key: id,
    title,
    projects: [],
    projectRefs: [{ environmentId: "hub", projectId: id }],
  }) as never;
const scopes = [scope("a", "Alpha"), scope("b", "Beta")];

let result: ReturnType<typeof useVisibleNewTaskScopes>;
function Probe(props: { search: string }) {
  result = useVisibleNewTaskScopes(scopes, props.search);
  return null;
}
async function mount(search: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(() =>
    createRoot(window.document.createElement("div")).render(<Probe search={search} />),
  );
  return { keys: result.visibleScopes.map((entry) => entry.key), lastUsedKey: result.lastUsedKey };
}

describe("useVisibleNewTaskScopes", () => {
  it.each([
    {
      name: "last used first, marked",
      preferences: AsyncResult.success({
        lastThreadProject: { environmentId: "hub", projectId: "b" },
      }),
      search: "",
      expected: { keys: ["b", "a"], lastUsedKey: "b" },
    },
    {
      name: "search narrows the ordered list",
      preferences: AsyncResult.success({
        lastThreadProject: { environmentId: "hub", projectId: "b" },
      }),
      search: "alp",
      expected: { keys: ["a"], lastUsedKey: "b" },
    },
    {
      name: "preferences not loaded yet keeps the order",
      preferences: AsyncResult.initial(),
      search: "",
      expected: { keys: ["a", "b"], lastUsedKey: null },
    },
  ])("$name", async ({ preferences, search, expected }) => {
    mocks.preferences = preferences;
    expect(await mount(search)).toEqual(expected);
  });
});
