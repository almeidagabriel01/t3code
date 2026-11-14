import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  share: vi.fn(),
  openPullRequest: vi.fn(),
  createUrl: vi.fn(),
  openLinked: vi.fn(),
  copy: vi.fn(),
  query: vi.fn(),
  canRead: { value: false },
}));

vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: () => {},
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: (_registry: unknown, query: unknown) => mocks.query(query),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => mocks.canRead.value,
  environmentSession: { sessionStateAtom: () => "session" },
  usePreparedConnection: () => ({ _tag: "None" }),
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null }),
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.createUrl }));
vi.mock("../../state/assets", () => ({ assetEnvironment: { createUrl: "createUrl" } }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => null } }));
vi.mock("../../state/entities", () => ({ resolveThreadLink: () => null }));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    searchEntries: (request: object) => ({ kind: "search", ...request }),
    fileMetadata: (request: object) => ({ kind: "metadata", ...request }),
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => "shell" },
}));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => mocks.openPullRequest,
}));
vi.mock("../../native/useEnrichedLinkVariants", () => ({
  enrichedThreadLinkCustomization: () => undefined,
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({
  copyTextWithHaptic: (text: string) => mocks.copy(text),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => mocks.openLinked }));
vi.mock("./useFileChipShare", () => ({ useFileChipShare: () => mocks.share }));
vi.mock("./ThreadInlineFilePreview", () => ({ ThreadInlineFilePreview: () => null }));
vi.mock("./ThreadMarkdownVideo", () => ({ ThreadMarkdownVideo: () => null }));
vi.mock("./ThreadMarkdownImage", () => ({
  ThreadMarkdownImage: () => null,
  ThreadMarkdownImageUnavailable: () => null,
  ThreadMarkdownImageView: () => null,
}));

import { hostedThreadLink } from "@t3tools/shared/threadLinks";
import type { ReactElement } from "react";

import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { fileRoutePathSegments } from "../files/filePath";
import { ThreadInlineFilePreview } from "./ThreadInlineFilePreview";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";
import { ThreadMarkdownVideo } from "./ThreadMarkdownVideo";
import {
  useMarkdownLinkHost,
  useMarkdownLinks,
  useThreadMarkdownLinks,
  type MarkdownLinkContext,
} from "./useThreadMarkdownLinks";

const environmentId = EnvironmentId.make("env");
const styles = { nativeTextStyle: {} } as never;
const A = { threadId: ThreadId.make("thread-a"), workspaceRoot: "/repo/a" };
const B = { threadId: ThreadId.make("thread-b"), workspaceRoot: "/repo/b" };

let root: Root;
let host: ReturnType<typeof useMarkdownLinkHost>;
let resolvers: Array<unknown> = [];
function Message(props: { readonly context: MarkdownLinkContext }) {
  resolvers.push(useMarkdownLinks(host, props.context).linkHandlers.resolveImageSource);
  return null;
}
const SKILLS = [{ name: "deploy", displayName: "Deploy", path: "/repo/a/skills/deploy.md" }];
function Host(props: { readonly scope: string; readonly messages?: ReadonlyArray<typeof A> }) {
  host = useMarkdownLinkHost({
    environmentId,
    scope: [props.scope],
    skills: SKILLS,
    markdownStyles: styles,
  });
  return props.messages?.map((context) => (
    <Message key={context.threadId} context={{ ...context }} />
  ));
}
const renderHost = (scope = "team", messages?: ReadonlyArray<typeof A>) =>
  act(() => root.render(<Host scope={scope} messages={messages} />));
const linksFor = (context: MarkdownLinkContext) => host.linksFor(context, async () => null);
const opened = (context: typeof A | typeof B, path: string, line?: string) => [
  "ThreadFile",
  {
    environmentId: "env",
    threadId: context.threadId,
    path: fileRoutePathSegments(path),
    ...(line === undefined ? {} : { line }),
  },
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  for (const fn of [
    mocks.navigate,
    mocks.share,
    mocks.openPullRequest,
    mocks.createUrl,
    mocks.openLinked,
    mocks.copy,
    mocks.query,
  ])
    fn.mockReset();
  mocks.canRead.value = false;
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("opens each message's file links in its own thread, resolved from its own root", () => {
  renderHost();
  linksFor(A).linkHandlers.onLinkPress("/repo/a/src/app.ts:3");
  linksFor(B).linkHandlers.onLinkPress("/repo/b/lib/util.ts");
  expect(mocks.navigate.mock.calls).toEqual([
    opened(A, "src/app.ts", "3"),
    opened(B, "lib/util.ts"),
  ]);
});

it("opens no file view and shares nothing for a link written outside a thread", () => {
  renderHost();
  const links = linksFor({ threadId: null, workspaceRoot: "/repo/a" }).linkHandlers;
  links.onLinkPress("/repo/a/src/app.ts");
  links.onFileContextMenuAction("/repo/a/src/app.ts", "save");
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.share).not.toHaveBeenCalled();
  linksFor(A).linkHandlers.onFileContextMenuAction("/repo/a/src/app.ts", "save");
  expect(mocks.share).toHaveBeenCalledWith(expect.anything(), A.threadId);
});

it("keeps one preview for every context, closed when the host's scope changes", () => {
  renderHost();
  act(() => linksFor(A).linkHandlers.onLinkPress("https://example.com/a.pdf"));
  expect(host.expandedFile).toMatchObject({ kind: "pdf", uri: "https://example.com/a.pdf" });
  act(() => linksFor(B).linkHandlers.onLinkPress("https://example.com/b.pdf"));
  expect(host.expandedFile).toMatchObject({ uri: "https://example.com/b.pdf" });
  act(() => host.closeFilePreview());
  expect(host.expandedFile).toBeNull();
  act(() => linksFor(A).linkHandlers.onLinkPress("https://example.com/a.pdf"));
  renderHost("other team");
  expect(host.expandedFile).toBeNull();
});

it("gives each message the same image resolver across renders, and another message its own", () => {
  resolvers = [];
  renderHost("team", [A, B]);
  renderHost("team", [A, B]);
  const [a, b, aAgain, bAgain] = resolvers;
  expect(aAgain).toBe(a);
  expect(bAgain).toBe(b);
  expect(b).not.toBe(a);
});

it("builds a thread's links from its fixed thread and root", () => {
  let links: ReturnType<typeof useThreadMarkdownLinks> | undefined;
  function Thread() {
    links = useThreadMarkdownLinks({
      environmentId,
      ...A,
      presentationKind: "thread",
      markdownStyles: styles,
    });
    return null;
  }
  act(() => root.render(<Thread />));
  links!.linkHandlers.onLinkPress("/repo/a/src/app.ts");
  expect(mocks.navigate.mock.calls).toEqual([opened(A, "src/app.ts")]);
});

it("opens skills, thread links and web links, and shows a web image in the preview", () => {
  renderHost();
  const links = linksFor(A).linkHandlers;
  links.onLinkPress("$deploy");
  expect(mocks.navigate.mock.calls).toEqual([opened(A, "/repo/a/skills/deploy.md")]);
  links.onLinkPress("t3-thread://v1/thread-z");
  expect(mocks.openLinked).toHaveBeenCalledWith({ environmentId: "env", threadId: "thread-z" });
  links.onLinkPress("https://github.com/acme/app/pull/1");
  expect(mocks.openPullRequest).toHaveBeenCalledWith("https://github.com/acme/app/pull/1");
  act(() => links.onImagePress?.("https://example.com/cat.png"));
  expect(host.expandedFile).toMatchObject({ kind: "image" });
  expect(links.fileEmbedLabel?.("/repo/a/notes.pdf", true)).toEqual(expect.any(String));
});

it("looks a media path and a bare file name up in the message's own project", async () => {
  mocks.canRead.value = true;
  mocks.query.mockImplementation(async (query: { kind: string }) =>
    query.kind === "search"
      ? { _tag: "Success", value: { entries: [{ path: "src/app.ts", kind: "file" }] } }
      : { _tag: "Success", value: null },
  );
  renderHost();
  await act(async () => linksFor(A).linkHandlers.onLinkPress("app.ts"));
  expect(mocks.query).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "search", input: expect.objectContaining({ cwd: "/repo/a" }) }),
  );
  expect(mocks.navigate).toHaveBeenLastCalledWith(...opened(A, "src/app.ts"));
  mocks.query.mockResolvedValue({ _tag: "Success", value: { entries: [] } });
  await act(async () => linksFor(B).linkHandlers.onLinkPress("util.ts"));
  expect(mocks.navigate).toHaveBeenLastCalledWith(...opened(B, "util.ts"));
  mocks.query.mockRejectedValue(new Error("offline"));
  await act(async () => linksFor(B).linkHandlers.onLinkPress("main.ts"));
  expect(mocks.navigate).toHaveBeenLastCalledWith(...opened(B, "main.ts"));
  mocks.query.mockResolvedValue({ _tag: "Success", value: { kind: "directory" } });
  await act(async () => linksFor(B).linkHandlers.onLinkPress("/repo/b/assets/logo.png"));
  expect(mocks.navigate).toHaveBeenLastCalledWith(...opened(B, "/repo/b/assets/logo.png"));
});

it("offers each link's own menu and runs its actions", () => {
  renderHost();
  const links = linksFor(A).linkHandlers;
  expect(links.fileContextMenu("$deploy")?.title).toBe("Deploy");
  links.onFileContextMenuAction("$deploy", "open-skill");
  links.onFileContextMenuAction("$deploy", "copy-skill");
  expect(mocks.navigate).toHaveBeenLastCalledWith(...opened(A, "/repo/a/skills/deploy.md"));
  expect(mocks.copy).toHaveBeenLastCalledWith("$deploy");
  const thread = "t3-thread://v1/thread-z";
  expect(links.fileContextMenu(thread)?.title).toBe("Thread");
  links.onFileContextMenuAction(thread, "open-thread");
  links.onFileContextMenuAction(thread, "copy-thread-link");
  expect(mocks.openLinked).toHaveBeenCalledOnce();
  expect(mocks.copy).toHaveBeenLastCalledWith(
    hostedThreadLink({ environmentId, threadId: ThreadId.make("thread-z") }),
  );
  const file = "/repo/a/src/app.ts";
  expect(links.fileContextMenu(file)?.actions.map((action) => action.id)).toContain("open-file");
  links.onFileContextMenuAction(file, "copy-full-path");
  expect(mocks.copy).toHaveBeenLastCalledWith(file);
  links.onFileContextMenuAction(file, "open-file");
  expect(mocks.navigate).toHaveBeenLastCalledWith(...opened(A, "src/app.ts"));
  links.onFileContextMenuAction("https://example.com", "open-file");
});

it("draws each embedded image by kind, with workspace files only inside a thread", () => {
  renderHost();
  const draw = (context: MarkdownLinkContext, href: string) =>
    linksFor(context).renderImage({ href, alt: null } as never) as ReactElement<{
      onOpen?: () => void;
      onPress?: () => void;
      resource?: { threadId: string };
    }>;
  expect(draw(A, "https://example.com/clip.mp4").type).toBe(ThreadMarkdownVideo);
  const audio = draw(A, "https://example.com/song.mp3");
  expect(audio.type).toBe(ThreadInlineFilePreview);
  act(() => audio.props.onOpen?.());
  const pdf = draw(A, "https://example.com/doc.pdf");
  act(() => pdf.props.onPress?.());
  expect(host.expandedFile).toMatchObject({ kind: "pdf" });
  expect(draw(A, "https://example.com/cat.png").type).toBe(ThreadMarkdownImageView);
  const local = draw(A, "/repo/a/cat.png");
  expect(local.type).toBe(ThreadMarkdownImage);
  expect(local.props.resource?.threadId).toBe(A.threadId);
  expect(draw({ threadId: null, workspaceRoot: "/repo/a" }, "/repo/a/cat.png").type).toBe(
    ThreadMarkdownImageUnavailable,
  );
});

it("resolves a web image directly and refuses a host file while offline", async () => {
  let resolve: ReturnType<typeof useMarkdownImageSource> | undefined;
  function Probe() {
    resolve = useMarkdownImageSource({ environmentId, ...A });
    return null;
  }
  act(() => root.render(<Probe />));
  const first = resolve;
  act(() => root.render(<Probe />));
  expect(resolve).toBe(first);
  await expect(
    resolve!({ href: "https://example.com/cat.png", alt: null, title: null }),
  ).resolves.toEqual({ uri: "https://example.com/cat.png" });
  await expect(resolve!({ href: "/repo/a/cat.png", alt: null, title: null })).rejects.toThrow(
    "unavailable",
  );
});
