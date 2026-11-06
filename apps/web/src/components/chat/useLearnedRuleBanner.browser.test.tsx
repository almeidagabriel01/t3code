import { EnvironmentId, MemoryItem, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { useLearnedRuleBanner } from "./useLearnedRuleBanner";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const environmentId = EnvironmentId.make("remote-owner");
const here = { environmentId, threadId: "thread-here" };
const decodeItem = Schema.decodeUnknownSync(MemoryItem);
const calls = vi.hoisted(() => ({ forget: vi.fn() }));

function rule(n: number, text: string, sourceThread: typeof here) {
  const revision = {
    memorySpaceId: id(1),
    memoryId: id(n),
    revisionId: id(n + 10),
    operationId: id(n + 20),
    parents: [],
    scope: { kind: "user" },
    payloadRef: id(n + 10),
    assertionKind: "fact",
    provenance: { environmentId },
    createdAtUtc: "2026-10-15T00:00:00.000Z",
  };
  return decodeItem({
    memorySpaceId: id(1),
    memoryId: id(n),
    status: "active",
    pendingSync: false,
    localAvailability: { exposure: "visible", reasons: [], deferred: [], cleanupPending: false },
    scope: { kind: "user" },
    revision,
    payload: {
      text,
      evidence: [{ origin: "user", sourceThread, messageIds: [] }],
      derivedFromMemoryRevisions: [],
    },
  });
}
const page1 = {
  items: [
    rule(2, "Rule: never rebase", here),
    rule(3, "Rule: learned elsewhere", { ...here, threadId: "thread-other" }),
  ],
  nextCursor: null,
  projectionWatermark: 1,
};

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../../state/memory", () => ({
  memoryEnvironment: {
    ...Object.fromEntries(
      ["syncStatus", "projectBindingGet", "upsert", "forget"].map((label) => [
        label,
        { label, permissionAtom: () => ({ label }) },
      ]),
    ),
    list: () => ({ label: "list" }),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { label: string } | null) => ({
    data: atom ? Option.some(page1) : null,
    refresh: () => {},
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "syncStatus"
      ? async () => ({ _tag: "Success", value: { state: "online", memorySpaceId: id(1) } })
      : async (input: unknown) => {
          calls.forget(input);
          return { _tag: "Success", value: { outcome: "deleted" } };
        },
}));

function Probe() {
  const item = useLearnedRuleBanner({
    environmentId,
    threadId: ThreadId.make(here.threadId),
    project: null,
    memoryAvailable: true,
  });
  return <ComposerBannerStack items={item ? [item] : []} />;
}

it("offers a rule learned in this thread and forgets it on Undo", async () => {
  window.localStorage.clear();
  // router: false -- the banner stack renders no links.
  await using screen = await render(<Probe />, { router: false });
  await expect.element(page.getByText("never rebase")).toBeVisible();
  expect(screen.container.textContent).not.toContain("learned elsewhere");

  await page.getByRole("button", { name: "Undo" }).click();

  expect(calls.forget).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ memoryId: id(2) }),
  });
  await expect.element(page.getByText("never rebase")).not.toBeInTheDocument();
});
