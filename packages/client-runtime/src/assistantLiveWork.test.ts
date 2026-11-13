import {
  AssistantId,
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type AssistantTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { assistantLiveWork, assistantSites, projectAssistantFaces } from "./assistantLiveWork.ts";
import { presentThreadShell } from "./state/models.ts";
import { v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";

const env = EnvironmentId.make("env");
type Status = "running" | "completed" | "failed" | "idle";

function shell(
  id: string,
  options: {
    status?: Status;
    project?: string;
    parent?: string;
    archived?: boolean;
    asks?: boolean;
    at?: string;
  } = {},
) {
  const presented = presentThreadShell(env, {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    projectId: ProjectId.make(options.project ?? "p1"),
    latestRunId: RunId.make(`run-${id}`),
    status: options.status ?? "running",
    lineage:
      options.parent === undefined
        ? v2ThreadShell.lineage
        : {
            parentThreadId: ThreadId.make(options.parent),
            relationshipToParent: "subagent" as const,
            rootThreadId: ThreadId.make(options.parent),
          },
  });
  return {
    ...presented,
    ...(options.at === undefined ? {} : { createdAt: options.at }),
    ...(options.archived ? { archivedAt: "2026-11-12T00:00:00.000Z" } : {}),
    ...(options.asks ? { hasPendingUserInput: true } : {}),
  };
}

const task = (threadId: string, assistantId = "ada", extra: Partial<AssistantTask> = {}) => ({
  environmentId: env,
  task: {
    threadId: ThreadId.make(threadId),
    assistantId: AssistantId.make(assistantId),
    projectId: ProjectId.make("ignored"),
    title: threadId,
    createdAt: "2026-11-12T10:00:00.000Z",
    ...extra,
  } as AssistantTask,
});

describe("assistantLiveWork", () => {
  it.each([
    {
      name: "a running launched task is a site in the thread's project",
      tasks: [task("t1")],
      shells: [shell("t1", { project: "web" })],
      sites: ["ada@web:t1:working"],
    },
    {
      name: "a task waiting on the user wears the waiting face",
      tasks: [task("t1")],
      shells: [shell("t1", { asks: true })],
      sites: ["ada@p1:t1:waiting"],
    },
    {
      name: "finished, failed, archived, dismissed and deleted tasks are not",
      tasks: [
        task("done"),
        task("failed"),
        task("archived"),
        task("dismissed", "ada", { dismissedAt: "2026-11-12T11:00:00.000Z" }),
        task("deleted"),
      ],
      shells: [
        shell("done", { status: "completed" }),
        shell("failed", { status: "failed" }),
        shell("archived", { archived: true }),
        shell("dismissed"),
      ],
      sites: [],
    },
    {
      name: "a live delegated child of the assistant's chat or group thread is a site",
      tasks: [],
      shells: [
        shell("assistant:ada:1", { status: "idle" }),
        shell("c1", { parent: "assistant:ada:1", project: "home" }),
        shell("c2", { parent: "assistant:bo:g-abc", project: "web", asks: true }),
      ],
      sites: ["ada@home:c1:working", "bo@web:c2:waiting"],
    },
    {
      name: "children of ordinary threads and finished children are not",
      tasks: [],
      shells: [
        shell("c1", { parent: "plain" }),
        shell("c2", { parent: "assistant:ada:1", status: "completed" }),
      ],
      sites: [],
    },
    {
      name: "one site per assistant and project, opening the newest thread there",
      tasks: [
        task("old", "ada", { createdAt: "2026-11-12T09:00:00.000Z" }),
        task("new", "ada", { createdAt: "2026-11-12T12:00:00.000Z" }),
        task("other", "ada", { createdAt: "2026-11-12T08:00:00.000Z" }),
      ],
      shells: [shell("old"), shell("new"), shell("other", { project: "web" })],
      sites: ["ada@p1:new:working", "ada@web:other:working"],
    },
  ])("$name", ({ tasks, shells, sites }) => {
    const work = assistantLiveWork({ tasks, shells });
    expect(
      work.sites.map((s) => `${s.assistantId}@${s.projectId}:${s.threadId}:${s.face}`).toSorted(),
    ).toEqual(sites.toSorted());
  });

  it("groups live children under their assistant, oldest first, across its threads", () => {
    const work = assistantLiveWork({
      tasks: [],
      shells: [
        shell("late", { parent: "assistant:ada:g-x", at: "2026-11-12T12:00:00.000Z" }),
        shell("early", { parent: "assistant:ada:1", at: "2026-11-12T09:00:00.000Z" }),
        shell("gone", { parent: "assistant:ada:1", status: "completed" }),
      ],
    });
    expect(work.subagents.get("env:ada")?.map((child) => child.id)).toEqual(["early", "late"]);
    expect(work.subagents.get("env:bo")).toBeUndefined();
  });
});

describe("assistantSites", () => {
  it("keeps the assistant's own sites in listed projects only", () => {
    const work = assistantLiveWork({
      tasks: [task("t1"), task("t2", "bo")],
      shells: [
        shell("t1", { project: "web" }),
        shell("t2", { project: "web" }),
        shell("c1", { parent: "assistant:ada:1", project: "assistants-home" }),
      ],
    });
    expect(
      assistantSites(work, "env", "ada", (projectId) => projectId !== "assistants-home").map(
        (site) => site.threadId,
      ),
    ).toEqual(["t1"]);
    expect(assistantSites(work, "other-env", "ada", () => true)).toEqual([]);
  });
});

describe("projectAssistantFaces", () => {
  const entry = (id: string, environmentId: string = env) => ({
    environmentId,
    assistant: { id },
  });
  const site = (assistantId: string, projectId: string, environmentId: string = env) => ({
    environmentId: EnvironmentId.make(environmentId),
    assistantId,
    projectId: ProjectId.make(projectId),
    threadId: ThreadId.make(`${assistantId}-task`),
    face: "working" as const,
  });
  const members = [{ environmentId: env as string, projectId: "web" }];

  it.each([
    {
      name: "working assistants come first, then configured ones, each once",
      sites: [site("bo", "web"), site("ada", "web")],
      configured: [entry("ada"), entry("cy")],
      faces: ["bo:working", "ada:working", "cy:configured"],
    },
    {
      name: "work in another project or environment does not count here",
      sites: [site("bo", "api"), site("ada", "web", "remote")],
      configured: [],
      faces: [],
    },
    {
      name: "an assistant no longer listed is skipped",
      sites: [site("gone", "web")],
      configured: [entry("ada")],
      faces: ["ada:configured"],
    },
  ])("$name", ({ sites, configured, faces }) => {
    expect(
      projectAssistantFaces({
        assistants: [entry("ada"), entry("bo"), entry("cy"), entry("ada", "remote")],
        configured,
        sites,
        members,
      }).map((face) => `${face.entry.assistant.id}:${face.site ? "working" : "configured"}`),
    ).toEqual(faces);
  });
});
