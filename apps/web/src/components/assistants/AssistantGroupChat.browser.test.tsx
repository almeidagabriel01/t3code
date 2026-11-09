import { createMemoryHistory } from "@tanstack/react-router";
import type {
  Assistant,
  AssistantGroupMessage,
  AssistantGroupTask,
  AssistantId,
  AssistantTeam,
  AssistantTeamId,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { openCommandPalette } from "~/commandPaletteBus";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { getRouter } from "~/router";
import { clearGroupDrafts } from "./GroupComposer";
import { assistantDialogAtom } from "./assistantDialogState";
import { assistantTeamDialogAtom } from "./assistantTeamState";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  fakeGroupChat,
  fakeTeamEdits,
  installFakeEnvironment,
  publishAssistants,
  publishGroupChat,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);
const uploads = vi.hoisted(() => ({ upload: vi.fn(), discard: vi.fn() }));
vi.mock(import("~/lib/attachmentUploadQueue"), async (original) => ({
  ...(await original()),
  uploadStandaloneAttachment: uploads.upload,
  discardStandaloneAttachment: uploads.discard,
}));
// A one-pixel image for every attachment, so thumbnails and the viewer have something to show.
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAACAkQBADs=";
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrls: (_environmentId, resources) => resources.map(() => PIXEL),
}));
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));
// A member's group thread that waits on the user: a real shell with its id and approval replaced.
const waiting = vi.hoisted(() => new Set<string>());
vi.mock(import("~/state/entities"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useThreadShell: (ref) => {
      const real = actual.useThreadShell(ref);
      const base = actual.useQuietThreadShells()[0]!;
      if (ref === null || !waiting.has(ref.threadId)) return real;
      return { ...base, id: ref.threadId, hasPendingApprovals: true } as typeof base;
    },
  };
});

installFakeEnvironment([threadWithHistory("thread-a", 2)], { assistants: true });
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const WHEN = "2026-03-17T19:00:00.000Z";
const assistant = (id: string, name: string, overrides: Partial<Assistant> = {}): Assistant => ({
  id: id as AssistantId,
  handle: id,
  name,
  projectId: PROJECT_ID,
  instructions: "",
  toolAccess: "workspace-write",
  isDefault: false,
  threadId: `assistant:${id}:1` as ThreadId,
  generation: 1,
  role: "",
  budget: null,
  askBeforeActing: false,
  workspace: "host",
  icon: null,
  avatar: null,
  scope: "all",
  mcpServers: [],
  autonomy: { mode: "reply-only", rules: null, projectIds: null, channels: null },
  archivedAt: null,
  createdAt: WHEN,
  updatedAt: WHEN,
  ...overrides,
});
const team = (overrides: Partial<AssistantTeam> = {}): AssistantTeam => ({
  id: "t1" as AssistantTeamId,
  name: "Leadership",
  memberIds: ["ada", "bo", "jarvis"] as AssistantId[],
  leadId: "jarvis" as AssistantId,
  archivedAt: null,
  createdAt: WHEN,
  updatedAt: WHEN,
  ...overrides,
});
const message = (seq: number, overrides: Partial<AssistantGroupMessage> = {}) =>
  ({
    id: `m${seq}`,
    teamId: "t1",
    seq,
    author: "user",
    assistantId: null,
    authorLabel: null,
    kind: "message",
    text: `message ${seq}`,
    replyToMessageId: null,
    taskId: null,
    createdAt: WHEN,
    ...overrides,
  }) as AssistantGroupMessage;
const task = (id: string, request: number, overrides: Partial<AssistantGroupTask> = {}) =>
  ({
    id,
    teamId: "t1",
    rootId: id,
    parentId: null,
    kind: "root",
    requestMessageId: `m${request}`,
    ownerId: "ada",
    instruction: `instruction of ${id}`,
    status: "running",
    reason: null,
    threadId: `assistant:ada:g-${"0".repeat(16)}`,
    createdAt: WHEN,
    updatedAt: WHEN,
    ...overrides,
  }) as AssistantGroupTask;

const people = () => [
  assistant("ada", "Ada", { role: "CFO" }),
  assistant("bo", "Bo"),
  assistant("jarvis", "Jarvis", { isDefault: true }),
];
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

async function openChat(options: { team?: AssistantTeam } = {}) {
  clearGroupDrafts();
  waiting.clear();
  appAtomRegistry.set(assistantDialogAtom, null);
  appAtomRegistry.set(assistantTeamDialogAtom, null);
  Object.assign(fakeGroupChat, {
    posts: [],
    taskActions: [],
    histories: [],
    postRefusal: null,
    older: null,
  });
  fakeTeamEdits.updates = [];
  publishAssistants(people(), [options.team ?? team()]);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/group/${ENVIRONMENT_ID}/t1`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return Object.assign(await render(<AppRoot router={router} />, { container, router: false }), {
    router,
  });
}

const main = () => page.getByRole("main");
const composer = () => page.getByRole("textbox", { name: "Message the group" });

it("shows requests, each member's answer, routing notes and the tasks between", async () => {
  publishGroupChat(
    [
      message(1, { text: "@Ada @Bo what does it cost?" }),
      message(2, { kind: "routing", author: "assistant", text: "Ada and Bo each got a task" }),
      message(3, {
        author: "assistant",
        assistantId: "bo" as AssistantId,
        taskId: "done" as never,
        text: "Three options compared.",
      }),
      message(4, { author: "routine", authorLabel: "Weekly review", text: "status?" }),
    ],
    [
      task("open", 1, { instruction: "Monthly cost and risk" }),
      task("done", 1, { ownerId: "bo" as AssistantId, status: "completed" }),
    ],
  );
  await using _screen = await openChat();
  await expect.element(main().getByText("Leadership")).toBeVisible();
  await expect.element(main().getByText("· 3 members · lead Jarvis")).toBeVisible();
  await expect.element(main().getByTestId("group-running")).toHaveTextContent("1 running");
  await expect.element(main().getByText("Ada and Bo each got a task")).toBeVisible();
  await expect.element(main().getByText("Three options compared.")).toBeVisible();
  await expect.element(main().getByText("Weekly review")).toBeVisible();
  const cards = main().getByTestId("group-task-card");
  await expect.element(cards.first()).toHaveAttribute("data-status", "running");
  await expect.element(main().getByText("Monthly cost and risk")).toBeVisible();
  await expect.element(cards.nth(1)).toHaveAttribute("data-status", "completed");
});

it("explains an empty chat by naming the members and how @ works", async () => {
  publishGroupChat([]);
  await using _screen = await openChat();
  await expect.element(main().getByText("No messages yet")).toBeVisible();
  await expect
    .element(
      main().getByText(/Ada, Bo, Jarvis are in this group.*@ada.*@everyone.*Jarvis routes it/),
    )
    .toBeVisible();
});

it("picks a member with @ and sends to who the preview names", async () => {
  publishGroupChat([message(1)]);
  await using _screen = await openChat();
  await userEvent.type(composer(), "@A");
  await expect.element(page.getByRole("option", { name: /Ada/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /@everyone/ })).not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  await expect.element(composer()).toHaveValue("@ada ");
  await userEvent.type(composer(), "do it");
  await expect.element(main().getByTestId("group-recipients")).toHaveTextContent("To Ada");
  await userEvent.keyboard("{Enter}");
  await eventually(() =>
    expect(fakeGroupChat.posts).toEqual([{ teamId: "t1", text: "@ada do it" }]),
  );
  await expect.element(composer()).toHaveValue("");
});

it("walks the picker with the arrows, closes it with Escape and lists the lead and everyone", async () => {
  publishGroupChat([message(1)]);
  await using _screen = await openChat();
  await userEvent.type(composer(), "@");
  await expect.element(page.getByRole("option", { name: /Jarvis.*lead/ })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
  await expect.element(composer()).toHaveValue("@everyone ");
  await userEvent.clear(composer());
  await userEvent.type(composer(), "@b");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("option")).not.toBeInTheDocument();
  await userEvent.keyboard("{Backspace}{ArrowUp}");
  await userEvent.type(composer(), "x");
  await userEvent.clear(composer());
  await userEvent.type(composer(), "no mention{Shift>}{Enter}{/Shift}more");
  await expect.element(composer()).toHaveValue("no mention\nmore");
  await expect
    .element(main().getByTestId("group-recipients"))
    .toHaveTextContent("Jarvis (lead) will route it");
});

it("keeps the draft and says what to do when the request names no one", async () => {
  publishGroupChat([message(1)]);
  await using _screen = await openChat();
  fakeGroupChat.postRefusal = { reason: "mention_required", message: "no" };
  await userEvent.type(composer(), "who does this?{Enter}");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Mention a member with @, or set a lead in Edit group.");
  await expect.element(composer()).toHaveValue("who does this?");
  fakeGroupChat.postRefusal = { reason: "archived", message: "no" };
  await userEvent.click(page.getByRole("button", { name: "Send" }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("This group is archived. Restore it to write here.");
  fakeGroupChat.postRefusal = null;
  await userEvent.type(composer(), "!");
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

it("says the lead is choosing while a request has no task yet", async () => {
  publishGroupChat([message(1, { text: "who takes this?" })]);
  await using _screen = await openChat();
  await expect
    .element(page.getByTestId("group-routing"))
    .toHaveTextContent("Jarvis (lead) is choosing who answers…");
  publishGroupChat([message(1, { text: "who takes this?" })], [task("t-1", 1)]);
  await expect.element(page.getByTestId("group-routing")).not.toBeInTheDocument();
});

it("labels a reply with the member it answers and previews it going to that member", async () => {
  publishGroupChat(
    [
      message(1, { author: "assistant", assistantId: "ada" as AssistantId, text: "done" }),
      message(2, { text: "why?", replyToMessageId: "m1" as never }),
    ],
    [task("t-1", 2)],
  );
  await using _screen = await openChat();
  await expect.element(page.getByText("Reply to Ada")).toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: /^Reply/ }).first());
  await userEvent.type(composer(), "and then?");
  await expect.element(page.getByText("To Ada", { exact: true })).toBeInTheDocument();
});

it("says on the card when the member waits for the user's approval", async () => {
  publishGroupChat([message(1, { text: "@ada go" })], [task("t-1", 1)]);
  await using _screen = await openChat();
  await expect.element(page.getByTestId("group-task-card")).toBeInTheDocument();
  await expect.element(page.getByTestId("group-task-needs")).not.toBeInTheDocument();
  waiting.add(`assistant:ada:g-${"0".repeat(16)}`);
  publishGroupChat([message(1, { text: "@ada go" })], [task("t-1", 1, { updatedAt: WHEN })]);
  await expect
    .element(page.getByTestId("group-task-needs"))
    .toHaveTextContent("Needs your approval · Open the conversation to answer");
});

it("keeps an unsent message when the user leaves the chat and comes back", async () => {
  publishGroupChat([message(1)]);
  await using screen = await openChat();
  await userEvent.type(composer(), "@ada half written");
  await screen.router.navigate({ to: "/assistants" });
  await expect.element(composer()).not.toBeInTheDocument();
  await screen.router.navigate({
    to: "/group/$environmentId/$teamId",
    params: { environmentId: ENVIRONMENT_ID, teamId: "t1" },
  });
  await expect.element(composer()).toHaveValue("@ada half written");
});

it("replies to a member's message and sends the reply link, or drops it", async () => {
  publishGroupChat(
    [
      message(1, { text: "@ada hi" }),
      message(2, { author: "assistant", assistantId: "ada" as AssistantId, text: "hello back" }),
      message(3, {
        author: "assistant",
        assistantId: "bo" as AssistantId,
        replyToMessageId: "m2" as never,
        text: "I agree",
      }),
    ],
    [],
  );
  await using _screen = await openChat();
  await expect.element(main().getByText("In reply to Ada")).toBeVisible();
  await userEvent.click(main().getByRole("button", { name: "Reply to Ada" }));
  await expect.element(main().getByTestId("group-reply-chip")).toHaveTextContent("Replying to Ada");
  await userEvent.click(main().getByRole("button", { name: "Cancel reply" }));
  await expect.element(main().getByTestId("group-reply-chip")).not.toBeInTheDocument();
  await userEvent.click(main().getByRole("button", { name: "Reply to Ada" }));
  await userEvent.type(composer(), "@ada thanks{Enter}");
  await eventually(() =>
    expect(fakeGroupChat.posts).toEqual([
      { teamId: "t1", text: "@ada thanks", replyToMessageId: "m2" },
    ]),
  );
  await expect.element(main().getByTestId("group-reply-chip")).not.toBeInTheDocument();
});

it("stops, resumes, reassigns and cancels tasks, and opens the owner's conversation", async () => {
  publishGroupChat(
    [message(1)],
    [
      task("run", 1),
      task("hold", 1, {
        ownerId: "bo" as AssistantId,
        status: "paused",
        reason: "handoff_limit",
        createdAt: "2026-03-17T19:01:00.000Z",
        threadId: `assistant:bo:g-${"1".repeat(16)}` as ThreadId,
      }),
      task("odd", 1, {
        status: "paused",
        reason: "something_new",
        createdAt: "2026-03-17T19:02:00.000Z",
      }),
    ],
  );
  await using screen = await openChat();
  const cards = main().getByTestId("group-task-card");
  await userEvent.click(cards.first().getByRole("button", { name: "Stop" }));
  await eventually(() =>
    expect(fakeGroupChat.taskActions).toEqual([{ taskId: "run", action: "stop" }]),
  );
  await expect.element(main().getByText("Hit 8 hand-offs for this request")).toBeVisible();
  await expect.element(main().getByText("Paused", { exact: true }).first()).toBeVisible();
  const held = cards.nth(1);
  await userEvent.click(held.getByRole("button", { name: "Resume" }));
  await userEvent.click(held.getByRole("button", { name: "Cancel" }));
  await userEvent.click(held.getByRole("button", { name: "Reassign" }));
  await expect.element(page.getByRole("menuitem", { name: "Bo" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("menuitem", { name: "Ada" }));
  await eventually(() =>
    expect(fakeGroupChat.taskActions.slice(1)).toEqual([
      { taskId: "hold", action: "resume" },
      { taskId: "hold", action: "cancel" },
      { taskId: "hold", action: "reassign", ownerId: "ada" },
    ]),
  );
  await userEvent.click(held.getByRole("button", { name: "Open conversation" }));
  await eventually(() =>
    expect(screen.router.state.location.pathname).toContain(
      encodeURIComponent(`assistant:bo:g-${"1".repeat(16)}`),
    ),
  );
});

it("pages in earlier messages above the newest ones", async () => {
  publishGroupChat([message(3, { text: "newest" })], [], true);
  await using _screen = await openChat();
  fakeGroupChat.older = {
    messages: [message(2, { text: "older one" })],
    tasks: [],
    hasMore: false,
  };
  await userEvent.click(main().getByRole("button", { name: "Load earlier messages" }));
  await eventually(() => expect(fakeGroupChat.histories).toEqual([{ teamId: "t1", beforeSeq: 3 }]));
  await expect.element(main().getByText("older one")).toBeVisible();
  await expect.element(main().getByText("newest")).toBeVisible();
  await expect
    .element(main().getByRole("button", { name: "Load earlier messages" }))
    .not.toBeInTheDocument();
});

it("shows an archived group as read-only with a way back", async () => {
  publishGroupChat([message(1)]);
  await using _screen = await openChat({ team: team({ archivedAt: WHEN }) });
  await expect.element(main().getByText("Archived · no new messages")).toBeVisible();
  await expect.element(composer()).toBeDisabled();
  await userEvent.click(main().getByRole("button", { name: "Restore" }).first());
  await eventually(() =>
    expect(fakeTeamEdits.updates).toMatchObject([{ teamId: "t1", archived: false }]),
  );
});

it("runs the header menu: edit, new assistant, schedule and archive", async () => {
  publishGroupChat([message(1)]);
  await using screen = await openChat();
  const menu = () => main().getByRole("button", { name: "Leadership actions" });
  await userEvent.click(menu());
  await userEvent.click(page.getByRole("menuitem", { name: "Edit group" }));
  expect(appAtomRegistry.get(assistantTeamDialogAtom)).toMatchObject({ teamId: "t1" });
  appAtomRegistry.set(assistantTeamDialogAtom, null);
  await userEvent.click(menu());
  await userEvent.click(page.getByRole("menuitem", { name: "New assistant in this group" }));
  expect(appAtomRegistry.get(assistantDialogAtom)).toMatchObject({ preset: { teamId: "t1" } });
  appAtomRegistry.set(assistantDialogAtom, null);
  await userEvent.click(menu());
  await userEvent.click(page.getByRole("menuitem", { name: "Archive group" }));
  await userEvent.click(page.getByRole("button", { name: "Confirm" }));
  await eventually(() =>
    expect(fakeTeamEdits.updates).toMatchObject([{ teamId: "t1", archived: true }]),
  );
  await userEvent.click(menu());
  await userEvent.click(page.getByRole("menuitem", { name: "Schedule in this group" }));
  await eventually(() => {
    expect(screen.router.state.location.pathname).toBe("/settings/scheduled-tasks");
    expect(screen.router.state.location.search).toMatchObject({ assistantTeamId: "t1" });
  });
  await expect.element(page.getByText("Group chat · Leadership")).toBeVisible();
});

it("opens a group's chat from the command palette and says when it is gone", async () => {
  publishGroupChat([]);
  const screen = await openChat();
  await using _disposable = screen;
  await screen.router.navigate({ to: "/assistants" });
  openCommandPalette({ query: "group chat" });
  await page.getByRole("option", { name: /Open group chat Leadership/ }).click();
  await eventually(() =>
    expect(screen.router.state.location.pathname).toBe(`/group/${ENVIRONMENT_ID}/t1`),
  );
  publishAssistants(people(), []);
  await expect.element(main().getByText("Group not found")).toBeVisible();
});

const paste = (target: Element, files: ReadonlyArray<File>) => {
  const clipboardData = new DataTransfer();
  for (const file of files) clipboardData.items.add(file);
  target.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
  );
};
const shot = () => new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
const sheet = () => new File(["%PDF"], "sheet.pdf", { type: "application/pdf" });
const broken = () => new File(["x"], "broken.txt", { type: "text/plain" });

it("attaches pasted files, keeps the others when one fails, and sends what is ready", async () => {
  publishGroupChat([message(1)]);
  uploads.upload.mockReset().mockReset();
  uploads.discard.mockReset();
  uploads.upload.mockImplementation(async (_environmentId: string, file: File) => {
    if (file.name === "broken.txt") throw new Error("Upload rejected (413)");
    return {
      attachmentId: `pending-${file.name}`,
      mimeType: file.type,
    };
  });
  await using _screen = await openChat();
  paste(composer().element(), [shot(), sheet(), broken()]);
  const chips = main().getByTestId("group-attachment-chip");
  await expect.element(chips.nth(0).getByText("shot.png")).toBeVisible();
  await expect.element(chips.nth(1).getByText("sheet.pdf")).toBeVisible();
  await expect.element(main().getByRole("alert")).toHaveTextContent("Upload rejected (413)");

  // The failed file holds the send until it is retried or removed; the others stay.
  await userEvent.type(composer(), "@ada see these");
  await expect.element(main().getByRole("button", { name: "Send" })).toBeDisabled();
  await userEvent.click(main().getByRole("button", { name: "Remove broken.txt" }));
  await expect.element(chips.nth(2)).not.toBeInTheDocument();
  await expect.element(main().getByRole("button", { name: "Send" })).toBeEnabled();

  // Removing a chip before sending deletes its upload.
  await userEvent.click(main().getByRole("button", { name: "Remove sheet.pdf" }));
  expect(uploads.discard).toHaveBeenCalledWith(ENVIRONMENT_ID, "pending-sheet.pdf");
  paste(composer().element(), [sheet()]);
  await expect.element(chips.nth(1).getByText("sheet.pdf")).toBeVisible();

  await expect.element(main().getByRole("button", { name: "Send" })).toBeEnabled();
  await userEvent.click(main().getByRole("button", { name: "Send" }));
  await eventually(() =>
    expect(fakeGroupChat.posts).toEqual([
      {
        teamId: "t1",
        text: "@ada see these",
        attachments: [
          {
            type: "image",
            id: "pending-shot.png",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
          {
            type: "file",
            id: "pending-sheet.pdf",
            name: "sheet.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4,
          },
        ],
      },
    ]),
  );
  await expect.element(main().getByTestId("group-attachment-chips")).not.toBeInTheDocument();
});

it("retries a failed upload from its chip, and the picker adds files too", async () => {
  publishGroupChat([message(1)]);
  uploads.discard.mockReset();
  let attempts = 0;
  uploads.upload.mockReset().mockImplementation(async (_environmentId: string, file: File) => {
    attempts += 1;
    if (attempts === 1) throw new Error("Upload failed");
    return { attachmentId: "pending-a", mimeType: file.type };
  });
  await using _screen = await openChat();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const files = new DataTransfer();
  files.items.add(sheet());
  input.files = files.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.element(main().getByRole("alert")).toHaveTextContent("Upload failed");
  await userEvent.click(main().getByRole("button", { name: "Retry sheet.pdf" }));
  await expect.element(main().getByRole("alert")).not.toBeInTheDocument();
  await userEvent.type(composer(), "@ada take it{Enter}");
  await eventually(() => expect(fakeGroupChat.posts).toHaveLength(1));
  expect(fakeGroupChat.posts[0]!.attachments).toHaveLength(1);
});

it("takes files dropped on the composer and shows the drop highlight while dragging", async () => {
  publishGroupChat([message(1)]);
  uploads.upload.mockReset().mockImplementation(async (_environmentId: string, file: File) => ({
    attachmentId: `pending-${file.name}`,
    mimeType: file.type,
  }));
  await using _screen = await openChat();
  const target = composer().element();
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(sheet());
  const drag = (type: string) =>
    target.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
  drag("dragover");
  drag("dragleave");
  // A drag that carries no files is left alone.
  target.dispatchEvent(
    new DragEvent("drop", { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true }),
  );
  expect(uploads.upload).not.toHaveBeenCalled();
  drag("drop");
  await expect
    .element(main().getByTestId("group-attachment-chip").getByText("sheet.pdf"))
    .toBeVisible();
  expect(uploads.upload).toHaveBeenCalledOnce();
});

it("shows a message's images as thumbnails that open the viewer and its files as chips", async () => {
  publishGroupChat([
    message(1, {
      text: "@ada look at these",
      attachments: [
        { type: "image", id: "g-1", name: "shot.png", mimeType: "image/png", sizeBytes: 2048 },
        {
          type: "file",
          id: "g-2",
          name: "sheet.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4096,
        },
      ],
    }),
  ]);
  await using _screen = await openChat();
  const attachments = main().getByTestId("group-message-attachments");
  await expect.element(attachments.getByRole("img", { name: "shot.png" })).toBeVisible();
  await expect
    .element(attachments.getByRole("button", { name: "Download sheet.pdf" }).getByText("4 KB"))
    .toBeVisible();
  await userEvent.click(attachments.getByRole("button", { name: "Preview shot.png" }));
  await expect.element(page.getByRole("dialog")).toBeVisible();
});
