import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { activeSubagentChildrenByParent } from "./sidebarSubagents.logic";

const environmentId = EnvironmentId.make("environment-local");
const parentId = ThreadId.make("parent");

function child(id: string, status: "running" | "completed" | "failed" | "idle") {
  return presentThreadShell(environmentId, {
    ...makeThreadFixture().source,
    id: ThreadId.make(id),
    latestRunId: RunId.make(`run-${id}`),
    status,
    lineage: { parentThreadId: parentId, relationshipToParent: "subagent", rootThreadId: parentId },
  });
}

describe("activeSubagentChildrenByParent", () => {
  it("lists only non-terminal subagent children under their parent", () => {
    const byParent = activeSubagentChildrenByParent([
      child("a", "running"),
      child("b", "completed"),
      child("c", "failed"),
      child("d", "idle"),
    ]);
    const children = byParent.get(scopedThreadKey(scopeThreadRef(environmentId, parentId)));
    expect(children?.map((thread) => thread.id)).toEqual(["a"]);
  });

  it("drops a parent once every child is terminal", () => {
    expect(activeSubagentChildrenByParent([child("b", "completed")]).size).toBe(0);
  });
});
