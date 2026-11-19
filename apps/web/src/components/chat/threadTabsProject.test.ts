import { ASSISTANT_THREAD_PREFIX, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { threadTabsProjectKey } from "./threadTabsProject";

const sideChatId = ThreadId.make("side");

// A null key means no tab drop zone: the thread neither splits nor joins a strip.
describe("threadTabsProjectKey", () => {
  it.each([
    ["a project thread", makeThreadFixture(), "environment-test:project-test"],
    [
      "an assistant thread",
      makeThreadFixture({ id: ThreadId.make(`${ASSISTANT_THREAD_PREFIX}helper`) }),
      null,
    ],
    [
      "a side chat",
      makeThreadFixture({
        id: sideChatId,
        lineage: {
          rootThreadId: sideChatId,
          parentThreadId: null,
          relationshipToParent: null,
          sideChat: true,
        },
      }),
      null,
    ],
    ["an unknown thread", null, null],
  ] as const)("keys %s", (_name, thread, key) => {
    expect(threadTabsProjectKey(thread)).toBe(key);
  });
});
