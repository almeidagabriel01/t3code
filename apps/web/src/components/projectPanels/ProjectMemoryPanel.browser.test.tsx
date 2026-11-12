import type { EnvironmentId, MemoryItem, ProjectId } from "@t3tools/contracts";
import { MEMORY_RULE_PREFIX } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

type Query = { readonly kind: "list" | "search"; readonly input: Record<string, unknown> };
type Page = { data: Option.Option<unknown> | null; error: string | null };

const mocks = vi.hoisted(() => ({
  canRead: true,
  space: "space-1" as string | null,
  scope: {
    status: "ready",
    scope: { kind: "project", projectKey: { kind: "explicit", key: "k" } },
  } as unknown,
  queries: [] as Query[],
  page: (_query: Query): Page => ({ data: null, error: null }),
  navigate: vi.fn(),
}));

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => mocks.canRead }));
vi.mock("../memory/useProjectMemoryScope", () => ({
  useMemorySpace: () => mocks.space,
  useProjectMemoryScope: () => mocks.scope,
}));
vi.mock("../../state/memory", () => ({
  memoryEnvironment: {
    list: (args: { input: Record<string, unknown> }) => ({ kind: "list", input: args.input }),
    search: (args: { input: Record<string, unknown> }) => ({ kind: "search", input: args.input }),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: Query) => {
    mocks.queries.push(query);
    return mocks.page(query);
  },
}));
vi.mock("../settings/MemorySettings", () => ({
  MemoryEditor: (props: { item: MemoryItem; onClose: () => void }) => (
    <div>
      <span>{`Editing ${props.item.memoryId}`}</span>
      <button type="button" onClick={props.onClose}>
        Close editor
      </button>
    </div>
  ),
  MemoryForgetControl: (props: { item: MemoryItem; compact?: boolean }) => (
    <button type="button" data-compact={props.compact}>
      Forget {props.item.memoryId}
    </button>
  ),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));

import { ProjectMemoryPanel } from "./ProjectMemoryPanel";

const memory = (id: string, text: string, over: Record<string, unknown> = {}) =>
  ({
    status: "active",
    memoryId: id,
    memorySpaceId: "space-1",
    pendingSync: false,
    scope: { kind: "project" },
    revision: { createdAtUtc: "2026-01-01T00:00:00.000Z" },
    payload: { text },
    ...over,
  }) as unknown as MemoryItem;

const page = (items: MemoryItem[], nextCursor: string | null = null): Page => ({
  data: Option.some({ items, nextCursor }),
  error: null,
});

function setup(over: Partial<typeof mocks> = {}) {
  mocks.canRead = true;
  mocks.space = "space-1";
  mocks.scope = {
    status: "ready",
    scope: { kind: "project", projectKey: { kind: "explicit", key: "k" } },
  };
  mocks.queries = [];
  mocks.page = () => page([]);
  mocks.navigate.mockReset();
  Object.assign(mocks, over);
}

const panel = () => (
  <ProjectMemoryPanel environmentId={"env" as EnvironmentId} projectId={"p1" as ProjectId} />
);

it("lists the project's memories with their marks, edits one in place and forgets from the row", async () => {
  setup({
    page: () =>
      page([
        memory("m1", "Use vp for every script"),
        memory("m2", `${MEMORY_RULE_PREFIX}Never commit to main`, { pendingSync: true }),
        memory("gone", "", { status: "forgotten" }),
      ]),
  });
  await using screen = await render(panel());
  const list = screen.getByRole("list", { name: "Project memories" });
  await expect.element(list.getByText("Use vp for every script")).toBeVisible();
  await expect.element(list.getByText("Never commit to main")).toBeVisible();
  expect(list.getByRole("listitem").elements()).toHaveLength(2);
  await expect.element(list.getByText("Rule")).toBeVisible();
  await expect.element(list.getByText("Not synced")).toBeVisible();
  expect(mocks.queries.at(-1)).toMatchObject({
    kind: "list",
    input: { memorySpaceId: "space-1", scope: { kind: "project" }, includeQuarantined: false },
  });
  await expect
    .element(list.getByRole("button", { name: "Forget m1" }))
    .toHaveAttribute("data-compact", "true");
  await userEvent.click(list.getByRole("button", { name: "Edit memory" }).first());
  await expect.element(list.getByText("Editing m1")).toBeVisible();
  await userEvent.click(list.getByRole("button", { name: "Close editor" }));
  await expect.element(list.getByText("Use vp for every script")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Memory settings" }));
  expect(mocks.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "/settings/memory",
      search: expect.objectContaining({ environmentId: "env" }),
    }),
  );
});

it("searches with the trimmed words and clears back to the list", async () => {
  setup({ page: (query) => (query.kind === "search" ? page([]) : page([memory("m1", "Hello")])) });
  await using screen = await render(panel());
  await userEvent.type(
    screen.getByRole("searchbox", { name: "Search project memories" }),
    "  deploy  ",
  );
  await expect.element(screen.getByText("No matching memories")).toBeVisible();
  expect(mocks.queries.at(-1)).toMatchObject({
    kind: "search",
    input: { query: "deploy", mode: "fts" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
  await expect.element(screen.getByText("Hello")).toBeVisible();
  await userEvent.type(
    screen.getByRole("searchbox", { name: "Search project memories" }),
    "x{Escape}",
  );
  await expect.element(screen.getByRole("searchbox")).toHaveValue("");
});

it("pages to older memories and back", async () => {
  setup({
    page: (query) =>
      query.input.cursor === "c1"
        ? page([memory("old", "Old one")])
        : page([memory("new", "New one")], "c1"),
  });
  await using screen = await render(panel());
  await expect.element(screen.getByRole("button", { name: "Newer" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Older" }));
  await expect.element(screen.getByText("Old one")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Older" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Newer" }));
  await expect.element(screen.getByText("New one")).toBeVisible();
});

it.each([
  { name: "no read access", over: { canRead: false }, text: "Memory read access needed" },
  { name: "memory off", over: { space: null }, text: "Memory is not ready" },
  {
    name: "scope loading",
    over: { scope: { status: "loading" } },
    text: "Loading project memory…",
  },
  {
    name: "no write access",
    over: { scope: { status: "no-permission" } },
    text: "Memory write access needed",
  },
  {
    name: "no shared key",
    over: { scope: { status: "no-key" } },
    text: "This project has no shared memory",
  },
  {
    name: "lookup failed",
    over: { scope: { status: "failed" } },
    text: "Could not load this project's memory",
  },
  {
    name: "page loading",
    over: { page: () => ({ data: null, error: null }) },
    text: "Loading memories…",
  },
  {
    name: "page failed",
    over: { page: () => ({ data: null, error: "boom" }) },
    text: "Could not load memories",
  },
  { name: "nothing yet", over: {}, text: "No memories yet" },
])("tells the user why there is no list: $name", async ({ over, text }) => {
  setup(over as Partial<typeof mocks>);
  await using screen = await render(panel());
  await expect.element(screen.getByText(text)).toBeVisible();
});
