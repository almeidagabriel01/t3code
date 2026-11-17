import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  shells: new Map<string, unknown>(),
  roots: new Map<string, string>(),
}));

vi.mock("../../state/entities", () => ({
  useQuietThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : (mocks.shells.get(ref.threadId) ?? null),
  useProject: (ref: { projectId: string } | null) =>
    ref === null ? null : { workspaceRoot: mocks.roots.get(ref.projectId) ?? null },
  useEnvironmentServerConfig: () => ({
    providers: [
      { instanceId: "claude", skills: [{ name: "claude-skill", enabled: true }] },
      { instanceId: "codex", skills: [{ name: "codex-skill", enabled: true }] },
    ],
  }),
}));
vi.mock("@t3tools/client-runtime/providerSkills", () => ({
  // The checkout the skills are read in, so the test sees which one was used.
  resolveProviderSkillsForCwd: (provider: { skills: Array<{ name: string }> }, cwd: unknown) =>
    provider.skills.map((skill) => ({ ...skill, cwd })),
}));

const { useGroupDraftSkills } = await import("./useGroupDraftSkills");

const member = (id: string, threadId: string | null) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  handle: id,
  threadId,
  projectId: `project-${id}`,
});
const ada = member("ada", "thread-ada");
const beto = member("beto", "thread-beto");
const cy = member("cy", null);
const members = [ada, beto, cy];

function read(input: {
  text: string;
  replyTo?: string | null;
  lead?: ReturnType<typeof member> | null;
  model?: { instanceId: string } | null;
}) {
  function Probe() {
    const skills = useGroupDraftSkills({
      environmentId: "hub" as never,
      text: input.text,
      members: members as never,
      lead: (input.lead === undefined ? ada : input.lead) as never,
      replyTo: input.replyTo ?? null,
      model: input.model as never,
    });
    return <output>{JSON.stringify(skills)}</output>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  const skills = JSON.parse(container.textContent!) as ReadonlyArray<{
    name: string;
    cwd: unknown;
  }>;
  act(() => root.unmount());
  return skills;
}

it.each([
  ["the lead without a mention", { text: "hi" }, "claude-skill", "/worktrees/ada"],
  ["the first member named", { text: "@beto hi @ada" }, "codex-skill", "/projects/beto"],
  ["the member a reply goes to", { text: "hi", replyTo: "Beto" }, "codex-skill", "/projects/beto"],
  [
    "the message's own model over the member's",
    { text: "@beto hi", model: { instanceId: "claude" } },
    "claude-skill",
    "/projects/beto",
  ],
] as const)("reads the skills of %s", (_name, input, skill, cwd) => {
  mocks.shells.set("thread-ada", {
    modelSelection: { instanceId: "claude" },
    worktreePath: "/worktrees/ada",
  });
  mocks.shells.set("thread-beto", { modelSelection: { instanceId: "codex" }, worktreePath: null });
  mocks.roots.set("project-beto", "/projects/beto");
  expect(read(input).map((entry) => [entry.name, entry.cwd])).toEqual([[skill, cwd]]);
});

it("offers none for a member without a thread, nor without anyone to answer", () => {
  expect(read({ text: "@cy hi", model: { instanceId: "claude" } })).toEqual([]);
  expect(read({ text: "hi", lead: null })).toEqual([]);
});
