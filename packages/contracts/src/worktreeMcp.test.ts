import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { WorktreeMcpFinishInput, WorktreeMcpFinishResult } from "./worktreeMcp.ts";

const decode = Schema.decodeUnknownSync(WorktreeMcpFinishResult);
const decodeInput = Schema.decodeUnknownSync(WorktreeMcpFinishInput);

describe("t3_worktree_finish schemas", () => {
  it("accepts every outcome and rejects unknown reasons", () => {
    for (const status of ["scheduled", "removed", "gone"] as const)
      expect(decode({ status, worktreePath: "/wt", detail: "" }).status).toBe(status);
    expect(
      decode({ status: "kept", worktreePath: "/wt", reason: "locked", detail: "" }).reason,
    ).toBe("locked");
    expect(() =>
      decode({ status: "kept", worktreePath: "/wt", reason: "busy", detail: "" }),
    ).toThrow();
    expect(() => decodeInput({ worktreePath: " " })).toThrow();
  });
});
