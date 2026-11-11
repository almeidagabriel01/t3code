import { EnvironmentId, ThreadId, type ProjectEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useFileExplorerHostActions } from "./useFileExplorerHostActions";

const state = vi.hoisted(() => ({
  launched: true,
  launch: [] as unknown[],
  openTerminal: [] as unknown[],
  projects: [] as unknown[],
  created: [] as unknown[],
  createFails: false,
  connection: { httpBaseUrl: "https://host.example" } as { httpBaseUrl: string } | null,
  listings: {} as Record<string, readonly ProjectEntry[]>,
  blobs: {} as Record<string, Blob>,
  downloads: [] as unknown[],
  toasts: [] as { type: string; title: string; description?: string }[],
}));

vi.mock("~/components/terminal/useThreadTerminalActions", () => ({
  useThreadTerminalActions: () => ({
    launchTerminal: (options: { place: (id: string) => void; location: unknown }) => {
      state.launch.push(options.location);
      options.place("term-1");
      return state.launched;
    },
  }),
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openTerminal: (...args: unknown[]) => state.openTerminal.push(args) }),
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (value: unknown) => {
    state.created.push(value);
    return state.createFails
      ? AsyncResult.failure(Cause.fail(new Error("Folder is gone.")))
      : AsyncResult.success(undefined);
  },
}));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner:
    () =>
    async ({ input }: { input: { resource: { path: string } } }) =>
      AsyncResult.success({ relativeUrl: `/assets${input.resource.path}` }),
}));
vi.mock("~/state/session", () => ({ readPreparedConnection: () => state.connection }));
vi.mock("~/state/entities", () => ({ readProjects: () => state.projects }));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: {} } }));
vi.mock("~/state/projects", () => ({
  projectEnvironment: { create: {}, listEntries: (value: unknown) => value },
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: async (_registry: unknown, query: { input: { directoryPath: string } }) => {
    const entries = state.listings[query.input.directoryPath];
    return entries
      ? AsyncResult.success({ entries, truncated: false })
      : AsyncResult.failure(Cause.fail(new Error("unreadable")));
  },
}));
vi.mock("~/components/media/mediaContent", () => ({
  readMediaBlob: async (url: string) => state.blobs[url] ?? new Blob([]),
  downloadMedia: async (url: string, name: string) => state.downloads.push([url, name]),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: (toast: (typeof state.toasts)[number]) => state.toasts.push(toast) },
}));

type Actions = ReturnType<typeof useFileExplorerHostActions>;

function setup() {
  state.launched = true;
  state.launch = [];
  state.openTerminal = [];
  state.projects = [];
  state.created = [];
  state.createFails = false;
  state.connection = { httpBaseUrl: "https://host.example" };
  state.listings = {};
  state.blobs = {};
  state.downloads = [];
  state.toasts = [];
}

const threadRef = {
  environmentId: EnvironmentId.make("env-host"),
  threadId: ThreadId.make("thread-host"),
};

async function mount() {
  const result: { current: Actions | null } = { current: null };
  function Probe(props: { readonly onRender: (actions: Actions) => void }) {
    props.onRender(
      useFileExplorerHostActions({
        environmentId: threadRef.environmentId,
        threadRef,
        cwd: "/repo",
      }),
    );
    return null;
  }
  const screen = await render(
    <Probe
      onRender={(actions) => {
        result.current = actions;
      }}
    />,
    { router: false }, // The hook renders nothing a router could serve.
  );
  return { screen, actions: () => result.current! };
}

describe("useFileExplorerHostActions", () => {
  it("opens a terminal in the folder and reports when it cannot", async () => {
    setup();
    const { screen, actions } = await mount();
    await using _screen = screen;
    actions().openInTerminal!("/repo/src");
    expect(state.launch).toEqual([{ cwd: "/repo/src", worktreePath: null }]);
    expect(state.openTerminal).toEqual([[threadRef, "term-1"]]);
    state.launched = false;
    actions().openInTerminal!("/repo/src");
    expect(state.toasts.at(-1)?.title).toBe("Could not open a terminal here");
  });

  it("adds a folder as a project once and reports existing projects and failures", async () => {
    setup();
    const { screen, actions } = await mount();
    await using _screen = screen;
    actions().addAsProject!("/repo/packages/app");
    await vi.waitFor(() => expect(state.toasts.at(-1)?.title).toBe("Project added"));
    expect(state.created).toMatchObject([
      {
        environmentId: threadRef.environmentId,
        input: { title: "app", workspaceRoot: "/repo/packages/app" },
      },
    ]);

    state.createFails = true;
    actions().addAsProject!("/repo/gone");
    await vi.waitFor(() =>
      expect(state.toasts.at(-1)).toMatchObject({
        title: "Could not add the project",
        description: "Folder is gone.",
      }),
    );

    state.projects = [
      { environmentId: threadRef.environmentId, workspaceRoot: "/repo/packages/app", title: "App" },
    ];
    actions().addAsProject!("/repo/packages/app");
    await vi.waitFor(() =>
      expect(state.toasts.at(-1)).toMatchObject({ title: "Already a project", description: "App" }),
    );
    expect(state.created).toHaveLength(2);
  });

  it("downloads a file through its asset URL and reports a lost connection", async () => {
    setup();
    const { screen, actions } = await mount();
    await using _screen = screen;
    actions().download!("docs/a.md", "file");
    await vi.waitFor(() =>
      expect(state.downloads).toEqual([["https://host.example/assets/repo/docs/a.md", "a.md"]]),
    );
    state.connection = null;
    actions().download!("docs/a.md", "file");
    await vi.waitFor(() =>
      expect(state.toasts.at(-1)).toMatchObject({
        title: "Download failed",
        description: "Reconnect to this environment and try again.",
      }),
    );
  });

  it("zips a folder's files under their folder paths", async () => {
    setup();
    state.listings = {
      docs: [
        { path: "docs/a.md", kind: "file" },
        { path: "docs/img", kind: "directory" },
        { path: "docs/img/b.png", kind: "file" },
      ],
      "docs/img": [{ path: "docs/img/b.png", kind: "file" }],
    };
    state.blobs = {
      "https://host.example/assets/repo/docs/a.md": new Blob(["# A"]),
      "https://host.example/assets/repo/docs/img/b.png": new Blob(["png"]),
    };
    const saved: { name: string; href: string }[] = [];
    using _click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push({ name: this.download, href: this.href });
    });
    const { screen, actions } = await mount();
    await using _screen = screen;
    actions().download!("docs", "directory");
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.name).toBe("docs.zip");
    const zip = await JSZip.loadAsync(await (await fetch(saved[0]!.href)).blob());
    expect(Object.keys(zip.files).filter((name) => !zip.files[name]!.dir)).toEqual([
      "a.md",
      "img/b.png",
    ]);
    expect(await zip.file("img/b.png")!.async("string")).toBe("png");

    actions().download!("missing", "directory");
    await vi.waitFor(() =>
      expect(state.toasts.at(-1)).toMatchObject({
        title: "Download failed",
        description: "Could not list missing.",
      }),
    );
  });
});
