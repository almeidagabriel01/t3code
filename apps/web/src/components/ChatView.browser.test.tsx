import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useAttachmentUploadStore } from "~/lib/attachmentUploadQueue";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  fakeCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

const toast = vi.hoisted(() => vi.fn());
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("a /side draft sends to a side chat; Toggle side chat opens its pane and closes it", async () => {
  await page.viewport(1400, 900);
  const parent = threadWithHistory("thread-parent", 1);
  using _environment = installFakeEnvironment([parent], { sideChats: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("thread-parent: question 0")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Toggle side chat" })).toBeVisible();
  await userEvent.type(page.getByTestId("composer-editor"), "/side why ");
  await expect.element(page.getByRole("button", { name: "Send to side chat" })).toBeVisible();
  await userEvent.clear(page.getByTestId("composer-editor"));
  await page.getByRole("button", { name: "Toggle side chat" }).click();
  await expect.element(page.getByRole("button", { name: "Close side chat" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Turn into thread" })).toBeVisible();
  await expect.element(page.getByTestId("composer-editor").last()).toBeVisible();

  await page.getByRole("button", { name: "Toggle side chat" }).click();
  await expect
    .element(page.getByRole("button", { name: "Close side chat" }))
    .not.toBeInTheDocument();
});

async function openSideChat() {
  await page.viewport(1400, 900);
  const parent = threadWithHistory("thread-parent", 1);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  return { parent, router };
}

it("/side shows the message in its tab before the server answers, and returns it to the composer when the start fails", async () => {
  const { parent, router } = await openSideChat();
  const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
  using _draft = {
    [Symbol.dispose]: () => useComposerDraftStore.getState().clearComposerContent(parentRef),
  };
  using _environment = installFakeEnvironment([parent], { sideChats: true });
  fakeCommands.holdTypes.add("thread.fork");
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const editor = page.getByTestId("composer-editor");
  await userEvent.type(editor, "/side why is it slow");
  await page.getByRole("button", { name: "Send to side chat" }).click();
  await expect.element(page.getByText("Starting the side chat…")).toBeVisible();
  await expect.element(page.getByText("why is it slow", { exact: true })).toBeVisible();
  await expect.element(editor).toHaveTextContent("");
  fakeCommands.refuseHeld();
  await expect.element(editor).toHaveTextContent("/side why is it slow");
  await expect.element(page.getByText("Starting the side chat…")).not.toBeInTheDocument();
});

function addImage(ref: ScopedThreadRef, name: string, mimeType: string) {
  const file = new File(["img"], name, { type: mimeType });
  useComposerDraftStore.getState().addImages(ref, [
    {
      type: "image",
      id: "side-image",
      name,
      mimeType,
      sizeBytes: file.size,
      previewUrl: URL.createObjectURL(file),
      file,
    },
  ]);
}

const draftImageNames = (ref: ScopedThreadRef) =>
  useComposerDraftStore
    .getState()
    .getComposerDraft(ref)
    ?.images.map((image) => image.name) ?? [];

it.each([
  {
    name: "is accepted",
    typed: "/side why is it slow",
    text: "why is it slow",
    fails: false,
    editorText: "",
    images: [],
  },
  {
    name: "is refused",
    typed: "/side why is it slow",
    text: "why is it slow",
    fails: true,
    editorText: "/side why is it slow",
    images: ["shot.png"],
  },
  // An image without a question asks about the image, as the main send does.
  {
    name: "is accepted with only an image",
    typed: "/side",
    text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    fails: false,
    editorText: "",
    images: [],
  },
])(
  "/side sends the message once the side chat exists: $name",
  async ({ typed, text, fails, editorText, images }) => {
    const { parent, router } = await openSideChat();
    const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
    using _draft = {
      [Symbol.dispose]: () => {
        useComposerDraftStore.getState().clearComposerContent(parentRef);
        useRightPanelStore.getState().closeAllSurfaces(parentRef);
        useAttachmentUploadStore.setState({ uploadsByImageId: {} });
      },
    };
    // An image already uploaded to the environment, as the composer's upload leaves it.
    addImage(parentRef, "shot.png", "image/png");
    useAttachmentUploadStore.setState({
      uploadsByImageId: {
        "side-image": { status: "ready", environmentId: ENVIRONMENT_ID, attachmentId: "upload-1" },
      },
    });
    using _environment = installFakeEnvironment([parent], { sideChats: true });
    if (fails) fakeCommands.failTypes.add("message.dispatch");
    await using _app = await render(<AppRoot router={router} />, { router: false });
    const editor = page.getByTestId("composer-editor").first();
    await userEvent.type(editor, typed);
    await page.getByRole("button", { name: "Send to side chat" }).click();
    // Ids, so a second send shows whether it repeated the command, the message or the thread.
    const sent = () =>
      fakeCommands.dispatched
        .filter((command) => command.type === "message.dispatch")
        .map((command) => {
          const { commandId, threadId, messageId } = command as unknown as Record<string, string>;
          return `${threadId} ${messageId} ${commandId}`;
        });
    await vi.waitFor(() => expect(sent()).not.toHaveLength(0));
    await expect.element(page.getByText("Starting the side chat…")).not.toBeInTheDocument();
    await expect.element(editor).toHaveTextContent(editorText);
    expect(sent()).toHaveLength(1);
    expect(fakeCommands.dispatched.find((command) => command.type === "message.dispatch")).toEqual(
      expect.objectContaining({
        text,
        attachments: [expect.objectContaining({ type: "image", name: "shot.png" })],
        context: { version: 1, records: [expect.objectContaining({ kind: "image" })] },
      }),
    );
    // A side chat that did not start gives the image back with the text.
    expect(draftImageNames(parentRef)).toEqual(images);
    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        parentRef,
      ).surfaces.filter((surface) => surface.kind === "side-chat"),
    ).toHaveLength(fails ? 0 : 1);
  },
);

it("/side starts no side chat when its image cannot upload, and gives it back", async () => {
  const { parent, router } = await openSideChat();
  const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
  using _draft = {
    [Symbol.dispose]: () => {
      useComposerDraftStore.getState().clearComposerContent(parentRef);
      useAttachmentUploadStore.setState({ uploadsByImageId: {} });
    },
  };
  // The upload queue refuses this type before reaching the server.
  addImage(parentRef, "shot.bmp", "image/bmp");
  using _environment = installFakeEnvironment([parent], { sideChats: true });
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const editor = page.getByTestId("composer-editor").first();
  await userEvent.type(editor, "/side why is it slow");
  await page.getByRole("button", { name: "Send to side chat" }).click();
  await expect.element(page.getByText("Attachment 'shot.bmp' failed to upload.")).toBeVisible();
  await expect.element(editor).toHaveTextContent("/side why is it slow");
  expect(draftImageNames(parentRef)).toEqual(["shot.bmp"]);
  expect(fakeCommands.dispatched.map((command) => command.type)).not.toContain("thread.fork");
});

it("/side refuses added context and keeps the draft", async () => {
  const { parent, router } = await openSideChat();
  const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
  using _draft = {
    [Symbol.dispose]: () => useComposerDraftStore.getState().clearComposerContent(parentRef),
  };
  using _environment = installFakeEnvironment([parent], { sideChats: true });
  toast.mockClear();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const editor = page.getByTestId("composer-editor");
  await userEvent.type(editor, "/side why is it slow");
  useComposerDraftStore
    .getState()
    .setThreadContexts(parentRef, [
      threadContextRecord(scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("thread-other")), "Other"),
    ]);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Side chats take text, images and files",
        description: "Remove the added context, then send it again.",
      }),
    ),
  );
  expect(useComposerDraftStore.getState().getComposerDraft(parentRef)?.prompt).toContain(
    "/side why is it slow",
  );
  expect(fakeCommands.dispatched.map((command) => command.type)).not.toContain("thread.fork");
});

it("Send to main chat puts a side chat answer into the parent composer", async () => {
  const { parent, router } = await openSideChat();
  const side = { ...threadWithHistory("thread-side", 1), sideChatOf: parent.id };
  using _environment = installFakeEnvironment([parent, side], { sideChats: true });
  const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
  useRightPanelStore.getState().openSideChat(parentRef, side.id);
  using _panel = {
    [Symbol.dispose]: () => useRightPanelStore.getState().closeAllSurfaces(parentRef),
  };
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await page.getByRole("button", { name: "Send to main chat" }).click();
  await vi.waitFor(() =>
    expect(page.getByTestId("composer-editor").first().element().textContent).toContain(
      "MIN_WIDTH",
    ),
  );
});

it("Turn into thread detaches the side chat, closes its pane and opens the thread", async () => {
  const { parent, router } = await openSideChat();
  using _environment = installFakeEnvironment([parent], { sideChats: true });
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await page.getByRole("button", { name: "Toggle side chat" }).click();
  await page.getByRole("button", { name: "Turn into thread" }).click();
  await expect
    .element(page.getByRole("button", { name: "Turn into thread" }))
    .not.toBeInTheDocument();
  const fork = fakeCommands.dispatched.find((command) => command.type === "thread.fork");
  const detach = fakeCommands.dispatched.find(
    (command) => command.type === "thread.metadata.update",
  );
  expect(detach).toMatchObject({ threadId: fork?.targetThreadId, detachSideChat: true });
  expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${fork?.targetThreadId}`);
});

it("Turn into thread shows an error toast and keeps the pane open when the server refuses", async () => {
  const { parent, router } = await openSideChat();
  using _environment = installFakeEnvironment([parent], { sideChats: true });
  toast.mockClear();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await page.getByRole("button", { name: "Toggle side chat" }).click();
  await expect.element(page.getByRole("button", { name: "Turn into thread" })).toBeVisible();
  fakeCommands.failTypes.add("thread.metadata.update");
  await page.getByRole("button", { name: "Turn into thread" }).click();
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not turn the side chat into a thread" }),
    ),
  );
  await expect.element(page.getByRole("button", { name: "Turn into thread" })).toBeVisible();
  expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${parent.id}`);
});

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("keeps an open file tab mounted behind the chat, so it returns where it was", async () => {
  await page.viewport(1400, 900);
  const thread = threadWithHistory("thread-files", 1);
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("thread-files: question 0")).toBeVisible();
  const ref = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  useRightPanelStore.getState().openFile(ref, "docs/plan.html");
  const tab = page.getByRole("tab", { name: /plan\.html/ });
  await expect.element(tab).toBeVisible();
  const panel = document.querySelector('[data-main-file-surface="file:docs/plan.html"]');
  expect(panel).not.toBeNull();

  useRightPanelStore.getState().showChat(ref);
  await vi.waitFor(() => expect(panel?.getAttribute("aria-hidden")).toBe("true"));
  expect(panel?.isConnected).toBe(true);
  await page.getByRole("button", { name: "plan.html", exact: true }).click();
  await vi.waitFor(() => expect(panel?.hasAttribute("aria-hidden")).toBe(false));
});

it("opens the thread actions menu for an older settled thread the shell leaves out", async () => {
  const thread = { ...threadWithHistory("older-settled", 1), olderSettled: true as const };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("older-settled: question 0")).toBeVisible();

  await page.getByRole("button", { name: `Thread actions for ${thread.title}` }).click();
  // Without a bound the poll runs to the test deadline and reports a bare timeout.
  await expect
    .element(page.getByRole("menuitem", { name: "Rename thread" }), { timeout: 5_000 })
    .toBeVisible();
});
