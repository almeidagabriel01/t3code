import { createMemoryHistory } from "@tanstack/react-router";
import {
  ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION,
  type Assistant,
  type AssistantGroupMessage,
  type AssistantGroupTask,
  type AssistantId,
  type AssistantTeam,
  type AssistantTeamId,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type { Editor } from "@tiptap/core";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { openCommandPalette } from "~/commandPaletteBus";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { openGroupTabsAtom } from "~/state/openGroupTabs";
import { getRouter } from "~/router";
import { clearGroupDrafts } from "./GroupComposer";
import { assistantDialogAtom } from "./assistantDialogState";
import {
  assistantGroupRoutinesAtom,
  assistantGroupSettingsAtom,
  assistantTeamDialogAtom,
} from "./assistantTeamState";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  fakeGroupChat,
  fakeSettings,
  fakeTeamEdits,
  installFakeEnvironment,
  publishAssistants,
  publishGroupChat,
  setFakeServerSettings,
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
// Dictation as the composer drives it: the stub button types what was "heard" through the hook.
const speech = vi.hoisted(() => ({
  input: null as null | {
    readonly text: string;
    readonly onTextChange: (text: string) => void;
    readonly offerSetup?: boolean | undefined;
  },
}));
vi.mock("~/speech/useTextFieldSpeech", () => ({
  TextFieldSpeechControls: () => (
    <button type="button" onClick={() => speech.input?.onTextChange("@bo dictated words")}>
      Dictate
    </button>
  ),
  SpeechTextField: () => null,
  useTextFieldSpeech: (input: NonNullable<typeof speech.input>) => {
    speech.input = input;
    return {
      preparing: false,
      blocksSubmission: false,
      freezesEditor: false,
      submitAfterDictation: (submit: (text: string) => void) => submit(speech.input!.text),
    };
  },
}));
// A member's group thread that waits on the user: a real shell with its id and approval replaced.
const waiting = vi.hoisted(() => new Set<string>());
// Member threads that run in their own worktree: thread id to worktree path.
const worktrees = vi.hoisted(() => new Map<string, string>());
vi.mock(import("~/state/entities"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useQuietThreadShell: (ref) => {
      const real = actual.useQuietThreadShell(ref);
      const base = actual.useQuietThreadShells()[0]!;
      const worktreePath = ref === null ? undefined : worktrees.get(ref.threadId);
      if (ref === null || worktreePath === undefined) return real;
      return { ...(real ?? base), id: ref.threadId, worktreePath } as typeof base;
    },
    useThreadShell: (ref) => {
      const real = actual.useThreadShell(ref);
      const base = actual.useQuietThreadShells()[0]!;
      if (ref === null || !waiting.has(ref.threadId)) return real;
      return { ...base, id: ref.threadId, hasPendingApprovals: true } as typeof base;
    },
  };
});

const SITE_PROJECT = "project-site" as ProjectId;
installFakeEnvironment([threadWithHistory("thread-a", 2)], {
  assistants: true,
  projects: [{ id: SITE_PROJECT, title: "site" }],
});
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
  projectIds: [],
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
  projectIds: [],
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

const TAB_KEY = `t3code:group-tab:${ENVIRONMENT_ID}:t1`;

async function openChat(
  options: {
    team?: AssistantTeam;
    people?: Assistant[];
  } = {},
) {
  localStorage.removeItem(TAB_KEY);
  clearGroupDrafts();
  waiting.clear();
  appAtomRegistry.set(assistantDialogAtom, null);
  appAtomRegistry.set(assistantTeamDialogAtom, null);
  appAtomRegistry.set(assistantGroupSettingsAtom, null);
  Object.assign(fakeGroupChat, {
    posts: [],
    taskActions: [],
    reads: [],
    conversations: [],
    histories: [],
    subscriptions: [],
    postRefusal: null,
    postGate: null,
    older: null,
  });
  fakeTeamEdits.updates = [];
  publishAssistants(options.people ?? people(), [options.team ?? team()]);
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
/** The Markdown the composer's editor holds, as it would be sent. */
const composerText = () => {
  const element = document.querySelector<HTMLElement & { editor: Editor }>(
    '[aria-label="Message the group"]',
  );
  return element === null ? null : serializeEditorDoc(element.editor.state.doc).value;
};
const expectComposer = (text: string) => eventually(() => expect(composerText()).toBe(text));

it("shows requests, each member's answer, routing notes and the tasks between", async () => {
  publishGroupChat(
    [
      message(1, { text: "@Ada @Bo what does it cost?\nAnd the risk?" }),
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
  await using screen = await openChat();
  const crumbs = main().getByRole("navigation", { name: "Group chat" });
  await expect.element(crumbs).toMatchTextContent(/^Assistants\/Leadership·/);
  await expect.element(main().getByText("· 3 members · lead Jarvis")).toBeVisible();
  await expect.element(main().getByTestId("group-running")).toHaveTextContent("1 running");
  await expect.element(main().getByText("Ada and Bo each got a task")).toBeVisible();
  await expect.element(main().getByText("Three options compared.")).toBeVisible();
  await expect.element(main().getByText("Weekly review")).toBeVisible();
  // A request keeps its line breaks, as the thread shows a user message.
  expect(document.querySelector('[data-testid="group-request"][data-message-id="m1"] br')).not.toBe(
    null,
  );
  // An open task keeps its card; a finished one is the thread's one activity line.
  const cards = main().getByTestId("group-task-card");
  await expect.element(cards.first()).toHaveAttribute("data-status", "running");
  await expect.element(main().getByText("Monthly cost and risk")).toBeVisible();
  await expect.element(cards.nth(1)).not.toBeInTheDocument();
  const answer = main().getByTestId("group-answer");
  await expect
    .element(answer.getByRole("button", { name: "Open task instruction of done" }))
    .toHaveAttribute("data-task-event-activity", "completed");
  await userEvent.click(crumbs.getByRole("button", { name: "Assistants" }));
  await eventually(() => expect(screen.router.state.location.pathname).toBe("/assistants"));
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
  await expectComposer("@ada ");
  await expect.element(composer().getByTestId("group-mention-chip")).toHaveTextContent("Ada");
  await userEvent.keyboard("do it");
  await expect.element(main().getByTestId("group-recipients")).toHaveTextContent("To Ada");
  await userEvent.keyboard("{Enter}");
  await eventually(() =>
    expect(fakeGroupChat.posts).toEqual([{ teamId: "t1", text: "@ada do it" }]),
  );
  await expectComposer("");
});

it("walks the picker with the arrows, closes it with Escape and lists the lead and everyone", async () => {
  publishGroupChat([message(1)]);
  await using _screen = await openChat();
  await userEvent.type(composer(), "@");
  await expect.element(page.getByRole("option", { name: /Jarvis.*lead/ })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
  await expectComposer("@everyone ");
  await userEvent.clear(composer());
  await userEvent.type(composer(), "@b");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("option")).not.toBeInTheDocument();
  await userEvent.keyboard("{Backspace}{ArrowUp}");
  await userEvent.type(composer(), "x");
  await userEvent.clear(composer());
  await userEvent.type(composer(), "no mention{Shift>}{Enter}{/Shift}more");
  await expectComposer("no mention\nmore");
  await expect
    .element(main().getByTestId("group-recipients"))
    .toHaveTextContent("Jarvis (lead) will route it");
});

it("writes lists, code and chips in the thread's editor and sends the exact Markdown", async () => {
  publishGroupChat([message(1)]);
  await using _screen = await openChat();
  publishAssistants(
    [...people(), assistant("ada_l", "Lovelace")],
    [team({ memberIds: ["ada", "bo", "jarvis", "ada_l"] as AssistantId[] })],
  );
  await userEvent.type(composer(), "- item");
  await expect.element(composer().getByRole("listitem")).toHaveTextContent("item");
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}@ad");
  await expect.element(page.getByRole("listbox", { name: "Mention" })).toBeVisible();
  await userEvent.keyboard("{Enter}fix #ren");
  await expect.element(page.getByRole("option", { name: /render/ })).toBeVisible();
  await userEvent.keyboard("{Tab}in snake_case for @love");
  await userEvent.keyboard("{Enter}");
  await expectComposer("- item\n- @ada fix #render in snake_case for @ada_l ");
  const chips = composer().getByTestId("group-mention-chip");
  await expect.element(chips.nth(0)).toHaveAttribute("data-mention-kind", "member");
  await expect.element(chips.nth(0)).toHaveTextContent("Ada");
  await expect.element(chips.nth(1)).toHaveAttribute("data-mention-kind", "project");
  await expect.element(chips.nth(1).getByText("render", { exact: true })).toBeVisible();
  await expect.element(chips.nth(2)).toHaveAttribute("data-mention-kind", "member");
  await expect.element(chips.nth(2)).toHaveTextContent("Lovelace");
  expect(composer().getByRole("listitem").elements()).toHaveLength(2);
  await userEvent.keyboard("{Enter}");
  await eventually(() =>
    expect(fakeGroupChat.posts).toEqual([
      { teamId: "t1", text: "- item\n- @ada fix #render in snake_case for @ada_l" },
    ]),
  );
  await expectComposer("");

  // A fence opens a code block where Enter is a new line and `@` picks nobody.
  await userEvent.keyboard("@bo see{Shift>}{Enter}{/Shift}```{Enter}a_b @ada{Enter}```{Enter}");
  await expect.element(page.getByRole("option")).not.toBeInTheDocument();
  await expectComposer("@bo see\n```\na_b @ada\n```\n");
  await userEvent.keyboard("{Enter}");
  await eventually(() =>
    expect(fakeGroupChat.posts.at(-1)).toEqual({
      teamId: "t1",
      text: "@bo see\n```\na_b @ada\n```",
    }),
  );
});

it("renders a sent message's Markdown with member and project chips, but not inside code", async () => {
  publishGroupChat([
    message(1, { text: "- @ada fix #render\n- check `@bo` first\n\n```\n@jarvis raw\n```" }),
  ]);
  await using _screen = await openChat();
  const request = main().getByTestId("group-request");
  await expect.element(request.getByRole("listitem").nth(1)).toHaveTextContent("check @bo first");
  const chips = request.getByTestId("group-mention-chip");
  await expect.element(chips.nth(0)).toHaveAttribute("data-mention-kind", "member");
  await expect.element(chips.nth(0)).toHaveTextContent("Ada");
  await expect.element(chips.nth(1)).toHaveAttribute("data-mention-kind", "project");
  await expect.element(chips.nth(1).getByText("render", { exact: true })).toBeVisible();
  await expect.element(chips.nth(2)).not.toBeInTheDocument();
  await expect.element(request.getByText(/raw/)).toBeVisible();
});

it("jumps from a reply's quote to the original and flashes it once", async () => {
  publishGroupChat([
    message(1, { author: "assistant", assistantId: "ada" as AssistantId, text: "the original" }),
    ...Array.from({ length: 24 }, (_, index) =>
      message(index + 2, {
        author: "assistant",
        assistantId: "bo" as AssistantId,
        text: `filler ${index}`,
      }),
    ),
    message(30, {
      author: "assistant",
      assistantId: "bo" as AssistantId,
      replyToMessageId: "m1" as never,
      text: "following up",
    }),
  ]);
  await using _screen = await openChat();
  // The first match is the message itself; the reply's quote repeats the text.
  const original = main().getByText("the original").first();
  await expect.element(main().getByText("following up")).toBeInViewport();
  await expect.element(original).not.toBeInViewport();
  await userEvent.click(main().getByTestId("group-reply-quote"));
  const row = document.querySelector('[data-message-id="m1"]')!;
  expect(row.getAnimations()).toHaveLength(1);
  await expect.element(original).toBeInViewport();

  // The composer's quote leads back the same way.
  await userEvent.click(main().getByRole("button", { name: "Reply to Ada" }));
  const feed = main().getByTestId("group-feed").element();
  feed.scrollTop = feed.scrollHeight;
  await expect.element(original).not.toBeInViewport();
  await userEvent.click(main().getByTestId("group-reply-jump"));
  await expect.element(original).toBeInViewport();
});

it("keeps the draft and says what to do when the request names no one", async () => {
  publishGroupChat([message(1)]);
  await using _screen = await openChat();
  fakeGroupChat.postRefusal = { reason: "mention_required", message: "no" };
  await userEvent.type(composer(), "who does this?{Enter}");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Mention a member with @, or set a lead in Edit group.");
  await expectComposer("who does this?");
  fakeGroupChat.postRefusal = { reason: "archived", message: "no" };
  await userEvent.click(page.getByRole("button", { name: "Submit message" }));
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
  await expect
    .element(page.getByTestId("group-reply-quote"))
    .toHaveTextContent("In reply to Ada done");
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
  await expectComposer("@ada half written");
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
  await expect
    .element(main().getByTestId("group-reply-quote"))
    .toHaveTextContent("In reply to Ada hello back");
  await userEvent.click(main().getByRole("button", { name: "Reply to Ada" }));
  await expect
    .element(main().getByTestId("group-reply-chip"))
    .toHaveTextContent("Replying to Ada hello back");
  await userEvent.click(main().getByRole("button", { name: "Cancel reply" }));
  await expect.element(main().getByTestId("group-reply-chip")).not.toBeInTheDocument();
  // Escape in the composer drops the reply too, once no suggestion list is open.
  await userEvent.click(main().getByRole("button", { name: "Reply to Ada" }));
  await userEvent.type(composer(), "@a");
  await expect.element(page.getByRole("option", { name: /Ada/ })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("option")).not.toBeInTheDocument();
  await expect.element(main().getByTestId("group-reply-chip")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(main().getByTestId("group-reply-chip")).not.toBeInTheDocument();
  await userEvent.keyboard("{Backspace}{Backspace}");
  await expectComposer("");
  await userEvent.click(main().getByRole("button", { name: "Reply to Ada" }));
  await userEvent.type(composer(), "@ada thanks{Enter}");
  await eventually(() =>
    expect(fakeGroupChat.posts).toEqual([
      { teamId: "t1", text: "@ada thanks", replyToMessageId: "m2" },
    ]),
  );
  await expect.element(main().getByTestId("group-reply-chip")).not.toBeInTheDocument();
});

it("shows a task's expected result and resources, and why a queued or limited one waits", async () => {
  const resetAt = "2099-03-04T09:30:00.000Z";
  publishGroupChat(
    [message(1)],
    [
      task("busy", 1, {
        status: "queued",
        reason: "waiting for folder:/w/app (used by Bo)",
        expectedResult: "the build is green",
        resources: ["folder:/w/app", "browser"],
      }),
      task("plain", 1, { createdAt: "2026-03-17T19:01:00.000Z" }),
      task("limited", 1, {
        status: "usage_limited",
        resetAt,
        createdAt: "2026-03-17T19:02:00.000Z",
      }),
    ],
  );
  await using _screen = await openChat();
  const cards = main().getByTestId("group-task-card");
  await expect
    .element(cards.nth(2).getByTestId("group-task-waiting"))
    .toHaveTextContent(
      `Limit until ${formatUpcomingTimestamp(resetAt, DEFAULT_CLIENT_SETTINGS.timestampFormat)}`,
    );
  await expect
    .element(cards.first().getByTestId("group-task-expected"))
    .toHaveTextContent("Expected: the build is green");
  await expect
    .element(cards.first().getByTestId("group-task-resources"))
    .toHaveTextContent("folder:/w/appbrowser");
  await expect
    .element(cards.first().getByTestId("group-task-waiting"))
    .toHaveTextContent("waiting for folder:/w/app (used by Bo)");
  await expect.element(cards.nth(1).getByTestId("group-task-expected")).not.toBeInTheDocument();
  await expect.element(cards.nth(1).getByTestId("group-task-waiting")).not.toBeInTheDocument();
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
  await expect
    .element(
      main().getByText(
        `${ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION} hand-offs since your last action`,
      ),
    )
    .toBeVisible();
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
  await expect.element(composer()).toHaveAttribute("aria-readonly", "true");
  await userEvent.click(main().getByRole("button", { name: "Restore" }).first());
  await eventually(() =>
    expect(fakeTeamEdits.updates).toMatchObject([{ teamId: "t1", archived: false }]),
  );
});

it("runs the header menu: edit, new assistant, routines and archive", async () => {
  publishGroupChat([message(1)]);
  await using _screen = await openChat();
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
  await userEvent.click(page.getByRole("menuitem", { name: "Group routines" }));
  expect(appAtomRegistry.get(assistantGroupRoutinesAtom)).toMatchObject({ teamId: "t1" });
  appAtomRegistry.set(assistantGroupRoutinesAtom, null);
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
  await expect
    .element(main().getByRole("button", { name: "Waiting for files to upload" }))
    .toBeDisabled();
  await userEvent.click(main().getByRole("button", { name: "Remove broken.txt" }));
  await expect.element(chips.nth(2)).not.toBeInTheDocument();
  await expect.element(main().getByRole("button", { name: "Submit message" })).toBeEnabled();

  // Removing a chip before sending deletes its upload.
  await userEvent.click(main().getByRole("button", { name: "Remove sheet.pdf" }));
  expect(uploads.discard).toHaveBeenCalledWith(ENVIRONMENT_ID, "pending-sheet.pdf");
  paste(composer().element(), [sheet()]);
  await expect.element(chips.nth(1).getByText("sheet.pdf")).toBeVisible();

  await expect.element(main().getByRole("button", { name: "Submit message" })).toBeEnabled();
  await userEvent.click(main().getByRole("button", { name: "Submit message" }));
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

const chatOf = (overrides: Partial<NonNullable<AssistantTeam["chat"]>> = {}) => ({
  latestSeq: 4,
  readSeq: 1,
  unreadCount: 2,
  working: false,
  preview: null,
  ...overrides,
});
// Only a request's lines count as unread; the user's "thanks" opens a second request.
const unreadChat = () =>
  publishGroupChat([
    message(1, inRequest(1)),
    message(2, {
      ...inRequest(1),
      author: "assistant",
      assistantId: "ada" as AssistantId,
      text: "first answer",
    }),
    message(3, { ...inRequest(3), text: "thanks" }),
    message(4, {
      ...inRequest(3),
      author: "assistant",
      assistantId: "bo" as AssistantId,
      text: "second answer",
    }),
  ]);

it("shows the unread count, a New line above the first unread message, and marks the chat read once seen", async () => {
  unreadChat();
  await using _screen = await openChat({ team: team({ chat: chatOf() }) });
  const row = page.getByTestId("sidebar-assistant-fold");
  await expect.element(row.getByTestId("group-unread")).toHaveTextContent("2");
  await expect.element(main().getByTestId("group-new-divider")).toBeVisible();
  // The line sits directly above the first answer the user had not read, not above their own message.
  const feed = main().getByTestId("group-feed").element();
  const order = [...feed.querySelectorAll("[data-testid]")].map((node) =>
    node.getAttribute("data-testid"),
  );
  expect(order.indexOf("group-new-divider")).toBe(order.indexOf("group-answer") - 1);
  await eventually(() => expect(fakeGroupChat.reads).toEqual([{ teamId: "t1", readSeq: 4 }]));
});

it("shows no badge and no New line and marks nothing when everything is read", async () => {
  unreadChat();
  await using _screen = await openChat({
    team: team({ chat: chatOf({ readSeq: 4, unreadCount: 0 }) }),
  });
  await expect.element(main().getByText("second answer")).toBeVisible();
  await expect.element(main().getByTestId("group-new-divider")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("group-unread")).not.toBeInTheDocument();
  expect(fakeGroupChat.reads).toEqual([]);
});

it("marks a group unread or read from its sidebar menu", async () => {
  unreadChat();
  await using _screen = await openChat({
    team: team({ chat: chatOf({ readSeq: 4, unreadCount: 0 }) }),
  });
  const actions = page
    .getByTestId("sidebar-assistant-fold")
    .getByRole("button", { name: "Leadership actions" });
  await userEvent.click(actions);
  await userEvent.click(page.getByRole("menuitem", { name: "Mark as unread" }));
  await eventually(() => expect(fakeGroupChat.reads).toEqual([{ teamId: "t1", unread: true }]));
  publishAssistants(people(), [team({ chat: chatOf({ readSeq: 1, unreadCount: 2 }) })]);
  await userEvent.click(actions);
  await userEvent.click(page.getByRole("menuitem", { name: "Mark as read" }));
  await eventually(() => expect(fakeGroupChat.reads.at(-1)).toEqual({ teamId: "t1", readSeq: 4 }));
});

const openGroupSettings = async () => {
  await userEvent.click(main().getByRole("button", { name: "Leadership actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Group settings" }));
};

it("edits the group's instructions and memories from its settings", async () => {
  publishGroupChat([message(1)]);
  await using _screen = await openChat({
    team: team({ instructions: "Be brief.", memories: ["Budget is 5k"] }),
  });
  await openGroupSettings();
  const instructions = page.getByRole("textbox", { name: "Group instructions" });
  await expect.element(instructions).toHaveValue("Be brief.");
  await expect.element(page.getByRole("textbox", { name: "Memory 1" })).toHaveValue("Budget is 5k");
  await userEvent.clear(instructions);
  await userEvent.type(instructions, "Be brief. Answer in Portuguese.");
  await userEvent.click(page.getByRole("button", { name: "Add memory" }));
  await userEvent.type(page.getByRole("textbox", { name: "Memory 2" }), "The year starts in March");
  await userEvent.click(page.getByRole("button", { name: "Remove memory 1" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeTeamEdits.updates).toEqual([
      {
        teamId: "t1",
        instructions: "Be brief. Answer in Portuguese.",
        memories: ["The year starts in March"],
      },
    ]),
  );
});

it("starts a new conversation with a divider above which the old messages stay, and can undo it", async () => {
  publishGroupChat([
    message(1),
    message(2, { author: "assistant", assistantId: "ada" as AssistantId, text: "an answer" }),
  ]);
  await using _screen = await openChat();
  await openGroupSettings();
  await expect.element(page.getByRole("button", { name: "Undo divider" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "New conversation" }));
  await eventually(() =>
    expect(fakeGroupChat.conversations).toEqual([{ teamId: "t1", action: "new" }]),
  );
  await expect
    .element(main().getByTestId("group-boundary"))
    .toHaveTextContent("New conversation started");
  await expect.element(main().getByText("an answer")).toBeVisible();
  await openGroupSettings();
  await userEvent.click(page.getByRole("button", { name: "Undo divider" }));
  await eventually(() =>
    expect(fakeGroupChat.conversations.at(-1)).toEqual({ teamId: "t1", action: "undo" }),
  );
});

it("clears the history only after a confirmation", async () => {
  publishGroupChat([message(1, { text: "an old request" })]);
  await using _screen = await openChat();
  await openGroupSettings();
  await userEvent.click(page.getByRole("button", { name: "Clear history" }));
  await userEvent.click(page.getByRole("button", { name: "Confirm" }));
  await eventually(() =>
    expect(fakeGroupChat.conversations).toEqual([{ teamId: "t1", action: "clear" }]),
  );
  await expect.element(main().getByText("No messages yet")).toBeVisible();
  await expect.element(main().getByText("an old request")).not.toBeInTheDocument();
});

it("keeps the conversation buttons off while the group is working", async () => {
  publishGroupChat([message(1)]);
  await using _screen = await openChat({ team: team({ chat: chatOf({ working: true }) }) });
  await userEvent.click(main().getByRole("button", { name: "Leadership actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Group settings" }));
  for (const name of ["New conversation", "Compact context", "Clear history"]) {
    await expect.element(page.getByRole("button", { name })).toBeDisabled();
  }
  await expect.element(page.getByText(/The group is working/)).toBeVisible();
});

const OTHER_PROJECT = "project-other" as ProjectId;
// Bo also works in a second project the client does not know, so its name falls back.
const twoProjectPeople = () => [
  assistant("ada", "Ada", { role: "CFO" }),
  assistant("bo", "Bo", { projectIds: [PROJECT_ID, OTHER_PROJECT] }),
  assistant("jarvis", "Jarvis", { isDefault: true }),
];
const inRequest = (root: number) => ({ requestId: `m${root}` as never });
const twoRequests = (other: ProjectId = OTHER_PROJECT) =>
  publishGroupChat(
    [
      message(1, { ...inRequest(1), projectId: PROJECT_ID, title: "Budget review" }),
      message(2, {
        ...inRequest(1),
        author: "assistant",
        assistantId: "ada" as AssistantId,
        taskId: "t-1" as never,
        text: "Budget answered",
      }),
      message(3, { ...inRequest(3), projectId: other, title: "Ship the app" }),
    ],
    [
      task("t-1", 1, {
        status: "completed",
        requestId: "m1" as never,
        instruction: "Request from Bo (an agent, not the user):\ninstruction of t-1",
      }),
      task("t-3", 3, { requestId: "m3" as never }),
    ],
  );
const blocks = () => main().getByTestId("group-request-block");

it("folds a finished request to one activity line and shows each answer as the thread does", async () => {
  twoRequests();
  await using _screen = await openChat();
  const done = blocks().first();
  // A finished request folds away to one line; the newest one stays open.
  const line = done.getByRole("button", { name: "Open request Budget review" });
  await expect.element(line).toHaveAttribute("data-task-event-activity", "completed");
  await expect.element(line).toMatchTextContent("· Finished · render");
  await expect.element(main().getByText("Budget answered")).not.toBeInTheDocument();
  const open = blocks().nth(1);
  await expect.element(open.getByTestId("group-request-title")).toHaveTextContent("Ship the app");
  await expect.element(open.getByTestId("group-request-status")).toHaveTextContent("Working");
  await expect
    .element(open.getByTestId("group-request-header"))
    .toHaveAttribute("aria-expanded", "true");
  // A running task keeps its card and actions.
  await expect
    .element(open.getByTestId("group-task-card"))
    .toHaveAttribute("data-status", "running");

  await userEvent.click(line);
  await expect.element(main().getByText("Budget answered")).toBeVisible();
  const answer = done.getByTestId("group-answer");
  await expect.element(done.getByTestId("group-task-card")).not.toBeInTheDocument();
  await expect
    .element(answer.getByRole("button", { name: "Open task instruction of t-1" }))
    .toHaveAttribute("data-task-event-activity", "completed");
  // The Worked fold holds the task's instruction.
  const worked = answer.getByRole("button", { name: "Worked" });
  await expect.element(worked).toHaveAttribute("aria-expanded", "false");
  await expect.element(answer.getByTestId("group-worked-instruction")).not.toBeInTheDocument();
  await userEvent.click(worked);
  await expect.element(worked).toHaveAttribute("aria-expanded", "true");
  await expect
    .element(answer.getByTestId("group-worked-instruction"))
    .toHaveTextContent("instruction of t-1");
  // Without the line naming who asked: the request above already shows that.
  await expect
    .element(answer.getByTestId("group-worked-instruction"))
    .not.toHaveTextContent("Request from");
  await userEvent.click(worked);
  await expect.element(answer.getByTestId("group-worked-instruction")).not.toBeInTheDocument();

  await userEvent.click(done.getByTestId("group-request-header"));
  await expect.element(main().getByText("Budget answered")).not.toBeInTheDocument();
});

it("folds a long answer behind Show more", async () => {
  publishGroupChat(
    [
      message(1, inRequest(1)),
      message(2, {
        ...inRequest(1),
        author: "assistant",
        assistantId: "ada" as AssistantId,
        taskId: "t-1" as never,
        text: Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n\n"),
      }),
    ],
    [task("t-1", 1, { status: "completed", requestId: "m1" as never })],
  );
  await using _screen = await openChat();
  await expect.element(main().getByText("line 0")).toBeVisible();
  const body = document.querySelector<HTMLElement>(
    '[data-testid="group-answer"] [data-user-message-collapsible]',
  )!;
  await expect.element(body).toHaveAttribute("data-user-message-collapsible", "true");
  await expect.element(body).toHaveAttribute("data-user-message-collapsed", "true");
  await userEvent.click(main().getByRole("button", { name: "Show more" }));
  await expect.element(body).toHaveAttribute("data-user-message-collapsed", "false");
});

it("marks each request on the minimap and opens the one picked", async () => {
  twoRequests();
  await using _screen = await openChat();
  await expect.element(main().getByTestId("timeline-minimap")).toBeInTheDocument();
  await eventually(() => expect(document.querySelectorAll("[data-minimap-strip]")).toHaveLength(2));
  // Marked as in view without a scroll: both requests fit on screen.
  await eventually(() =>
    expect(document.querySelectorAll('[data-minimap-strip][data-in-view="true"]')).toHaveLength(2),
  );
  await expect.element(main().getByText("Budget answered")).not.toBeInTheDocument();
  const rail = main().getByRole("button", { name: /^Jump to message/ });
  (rail.element() as HTMLElement).focus();
  await userEvent.keyboard("{Home}{Enter}");
  await expect
    .element(main().getByTestId("group-answer").getByText("Budget answered"))
    .toBeInViewport();
});

// Bo works in both known projects, so the group has two and its chat has a tab for each.
const sitePeople = () => [
  assistant("ada", "Ada", { role: "CFO" }),
  assistant("bo", "Bo", { projectIds: [PROJECT_ID, SITE_PROJECT] }),
  assistant("jarvis", "Jarvis", { isDefault: true }),
];
const scopedChat = () =>
  chatOf({
    latestSeq: 3,
    unreadCount: 2,
    // More than the one running task this tab loads: other tabs run work too.
    runningCount: 3,
    scopes: [
      { projectId: PROJECT_ID, unreadCount: 2, waiting: false, readSeq: 1 },
      { projectId: SITE_PROJECT, unreadCount: 0, waiting: true, readSeq: 3 },
    ],
  });
const tabRow = () => main().getByRole("group", { name: "Project tabs" });
// A tab's name also carries its count and waiting dot.
const tab = (name: string) => tabRow().getByRole("button", { name: new RegExp(`^${name}\\b`) });
const composerProject = () => main().getByRole("combobox", { name: "Project" });

it("shows a tab per project with its unread count and waiting dot, only when the server sends them", async () => {
  twoRequests(SITE_PROJECT);
  await using _screen = await openChat({ people: sitePeople(), team: team({ chat: chatOf() }) });
  await expect.element(main().getByText("Ship the app")).toBeVisible();
  // An older server sends no scopes: today's view, unscoped.
  await expect.element(tabRow()).not.toBeInTheDocument();
  publishAssistants(sitePeople(), [team({ chat: scopedChat() })]);
  await expect.element(tab("All")).toHaveAttribute("aria-pressed", "true");
  await expect.element(tab("render")).toMatchTextContent("render2");
  await expect.element(tab("site").getByLabelText("Waiting on you")).toBeVisible();
  await expect.element(tab("All").getByLabelText("Waiting on you")).toBeVisible();
  await expect.element(tab("render").getByLabelText("Waiting on you")).not.toBeInTheDocument();
  expect(tab("site").element().textContent).not.toMatch(/\d/);
  // One project has nothing to switch between.
  publishAssistants(people(), [team({ chat: scopedChat() })]);
  await expect.element(tabRow()).not.toBeInTheDocument();
  // Without tabs nothing reads a scope (the unscoped stream may still be cached from before).
  expect(fakeGroupChat.subscriptions.filter((input) => "scope" in input)).toEqual([]);
});

it("reads nothing, and shows no untabbed feed, while a member of a tabbed group is still loading", async () => {
  twoRequests(SITE_PROJECT);
  const loaded = sitePeople();
  await using _screen = await openChat({
    people: loaded.filter((person) => person.id !== "bo"),
    team: team({ chat: scopedChat() }),
  });
  await expect.element(composer()).toBeVisible();
  await expect.element(main().getByText("Ship the app")).not.toBeInTheDocument();
  // Nothing is read before the tab is known: not the whole chat, not a scope.
  expect(fakeGroupChat.subscriptions).toEqual([]);
  // Nor does it count as showing All, which would hide every tab's finished notice.
  const shownTabs = () => [...appAtomRegistry.get(openGroupTabsAtom).values()].map((e) => e.tab);
  expect(shownTabs()).toEqual([undefined]);
  publishAssistants(loaded, [team({ chat: scopedChat() })]);
  await expect.element(tab("All")).toHaveAttribute("aria-pressed", "true");
  expect(shownTabs()).toEqual(["all"]);
  await expect.element(main().getByText("Ship the app")).toBeVisible();
  expect(fakeGroupChat.reads).toEqual([]);
});

it("narrows the feed to a project tab, keeps the draft, sets the composer's project and remembers the tab", async () => {
  twoRequests(SITE_PROJECT);
  const chat = scopedChat();
  const scopes = [...chat.scopes!, { projectId: null, unreadCount: 0, waiting: false, readSeq: 3 }];
  await using screen = await openChat({
    people: sitePeople(),
    team: team({ chat: { ...chat, scopes } }),
  });
  await userEvent.type(composer(), "@bo draft");
  await userEvent.click(tab("site"));
  await expect.element(tab("site")).toHaveAttribute("aria-pressed", "true");
  await expect.element(main().getByText("Budget review")).not.toBeInTheDocument();
  await expect.element(blocks().first().getByText("Ship the app")).toBeVisible();
  await expectComposer("@bo draft");
  await expect.element(composerProject()).toHaveTextContent("site");
  await eventually(() =>
    expect(fakeGroupChat.subscriptions).toContainEqual({
      teamId: "t1",
      scope: { projectId: SITE_PROJECT },
    }),
  );
  // All and General leave the project to the lead; a pick lasts only in the tab it was made in.
  await userEvent.click(tab("All"));
  await expect.element(composerProject()).toHaveTextContent("Lead decides");
  await userEvent.click(composerProject());
  await userEvent.click(page.getByRole("option", { name: "site" }));
  await userEvent.click(tab("render"));
  await expect.element(composerProject()).toHaveTextContent("render");
  await userEvent.click(tab("All"));
  await expect.element(composerProject()).toHaveTextContent("Lead decides");
  await userEvent.click(tab("render"));
  await expect.element(composerProject()).toHaveTextContent("render");
  await eventually(() =>
    expect(fakeGroupChat.reads).toEqual([
      { teamId: "t1", readSeq: 3, scope: { projectId: PROJECT_ID } },
    ]),
  );
  // The header counts the whole group's running tasks, not only this tab's.
  await expect.element(main().getByTestId("group-running")).toHaveTextContent("3 running");
  // A tab switch closes an open reply, which would answer a request out of view; the draft stays.
  await userEvent.click(tab("site"));
  await userEvent.click(main().getByRole("button", { name: "Reply to request Ship the app" }));
  await expect.element(main().getByTestId("group-reply-chip")).toBeVisible();
  await userEvent.click(tab("render"));
  await expect.element(main().getByTestId("group-reply-chip")).not.toBeInTheDocument();
  await expectComposer("@bo draft");
  // A send to another project follows it to its tab.
  await userEvent.click(composerProject());
  await userEvent.click(page.getByRole("option", { name: "site" }));
  await userEvent.type(composer(), "{Enter}");
  await eventually(() =>
    expect(fakeGroupChat.posts).toEqual([
      { teamId: "t1", text: "@bo draft", projectId: SITE_PROJECT },
    ]),
  );
  await expect.element(tab("site")).toHaveAttribute("aria-pressed", "true");
  await screen.router.navigate({ to: "/assistants" });
  await expect.element(composer()).not.toBeInTheDocument();
  await screen.router.navigate({
    to: "/group/$environmentId/$teamId",
    params: { environmentId: ENVIRONMENT_ID, teamId: "t1" },
  });
  await expect.element(tab("site")).toHaveAttribute("aria-pressed", "true");
  await expect.element(main().getByText("Budget review")).not.toBeInTheDocument();
  // One with no project yet goes to All: the lead may still move it to another tab.
  await userEvent.click(composerProject());
  await userEvent.click(page.getByRole("option", { name: "Lead decides" }));
  await userEvent.type(composer(), "@bo later{Enter}");
  await expect.element(tab("All")).toHaveAttribute("aria-pressed", "true");
  // A tab opened, or a reply started, while the post was on its way is where the user stays.
  const sendHeld = async (opened: string, pick = "render") => {
    const posted = fakeGroupChat.posts.length;
    let open!: () => void;
    fakeGroupChat.postGate = new Promise((resolve) => (open = resolve));
    await userEvent.click(tab("site"));
    await userEvent.click(composerProject());
    await userEvent.click(page.getByRole("option", { name: pick }));
    await userEvent.type(composer(), "@bo late{Enter}");
    await eventually(() => expect(fakeGroupChat.posts).toHaveLength(posted + 1));
    await userEvent.click(tab(opened));
    return open;
  };
  const posts = fakeGroupChat.posts.length;
  for (const [opened, pick] of [
    ["All", "render"],
    ["General", "render"],
    ["render", "site"],
  ] as const) {
    (await sendHeld(opened, pick))();
    await eventually(() => expect(composerText()).toBe(""));
    await expect.element(tab(opened)).toHaveAttribute("aria-pressed", "true");
  }
  const open = await sendHeld("render");
  await userEvent.click(main().getByRole("button", { name: "Reply to request Budget review" }));
  open();
  await eventually(() => expect(composerText()).toBe(""));
  expect(fakeGroupChat.posts).toHaveLength(posts + 4);
  await expect.element(tab("render")).toHaveAttribute("aria-pressed", "true");
  await expect.element(main().getByTestId("group-reply-chip")).toBeVisible();
});

it("shows every request in All as one line with its project, opened in place, and marks nothing read", async () => {
  twoRequests(SITE_PROJECT);
  await using _screen = await openChat({
    people: sitePeople(),
    team: team({ chat: scopedChat() }),
  });
  const newest = blocks().nth(1).getByRole("button", { name: "Expand request Ship the app" });
  await expect.element(newest).toMatchTextContent("· Workingsite");
  const done = blocks().first().getByRole("button", { name: "Expand request Budget review" });
  await expect.element(done).toMatchTextContent("· Finishedrender");
  await expect.element(main().getByText("Budget answered")).not.toBeInTheDocument();
  await userEvent.click(done);
  await expect.element(main().getByText("Budget answered")).toBeVisible();
  await userEvent.click(
    blocks().first().getByRole("button", { name: "Collapse request Budget review" }),
  );
  await expect.element(main().getByText("Budget answered")).not.toBeInTheDocument();
  expect(fakeGroupChat.reads).toEqual([]);
});

it("numbers a removed project by the server's list, so an older page renumbers nothing", async () => {
  // gone-a's request is on a page not loaded yet; the server already counts it.
  publishGroupChat(
    [message(1, { ...inRequest(1), projectId: "gone-b" as ProjectId, title: "Request 1" })],
    [],
  );
  await using _screen = await openChat({
    people: sitePeople(),
    team: team({
      chat: { ...scopedChat(), removedProjectIds: ["gone-a", "gone-b"] as ProjectId[] },
    }),
  });
  await expect
    .element(blocks().first().getByTestId("group-request-chip"))
    .toHaveTextContent("Removed project 2");
});

it("keeps the number that tells two removed projects apart when their chips truncate", async () => {
  const gone = ["gone-a", "gone-b"] as unknown as ReadonlyArray<ProjectId>;
  publishGroupChat(
    gone.map((projectId, index) =>
      message(index + 1, { ...inRequest(index + 1), projectId, title: `Request ${index + 1}` }),
    ),
    [],
  );
  const chat = scopedChat();
  const orphans = gone.map((projectId) => ({
    projectId,
    unreadCount: 1,
    waiting: false,
    readSeq: 0,
  }));
  await using _screen = await openChat({
    people: sitePeople(),
    team: team({ chat: { ...chat, scopes: [...chat.scopes!, ...orphans] } }),
  });
  const chip = blocks().nth(1).getByTestId("group-request-chip");
  await expect.element(chip).toHaveTextContent("Removed project 2");
  const tail = chip.getByText("2", { exact: true });
  await expect.element(tail).toBeVisible();
  expect(tail.element().getBoundingClientRect().right).toBeLessThanOrEqual(
    chip.element().getBoundingClientRect().right,
  );
});

it("picks a project for a new request and keeps a reply in its request's project", async () => {
  twoRequests();
  await using _screen = await openChat();
  publishAssistants(twoProjectPeople(), [team()]);
  await userEvent.click(main().getByRole("combobox", { name: "Project" }));
  await userEvent.click(page.getByRole("option", { name: "render" }));
  await userEvent.type(composer(), "@ada new work{Enter}");
  await eventually(() =>
    expect(fakeGroupChat.posts).toEqual([
      { teamId: "t1", text: "@ada new work", projectId: PROJECT_ID },
    ]),
  );
  // The pick was for that request: the next one is the lead's to place again.
  await expect.element(composerProject()).toHaveTextContent("Lead decides");
  await userEvent.click(
    blocks().first().getByRole("button", { name: "Open request Budget review" }),
  );
  await userEvent.click(main().getByRole("button", { name: "Reply to Ada" }));
  await expect.element(main().getByTestId("group-project-locked")).toHaveTextContent("render");
  await expect.element(main().getByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
  await userEvent.type(composer(), "@ada more{Enter}");
  await eventually(() =>
    expect(fakeGroupChat.posts.at(-1)).toEqual({
      teamId: "t1",
      text: "@ada more",
      replyToMessageId: "m2",
    }),
  );
});

it("picks the composer's model for the next message only, never as the project's default", async () => {
  fakeSettings.patches = [];
  fakeSettings.refuse = null;
  setFakeServerSettings(null);
  twoRequests(SITE_PROJECT);
  await using _screen = await openChat({
    people: sitePeople(),
    team: team({ chat: scopedChat() }),
  });
  // The lead decides the project, so there is no project model to show.
  await expect.element(main().getByRole("button", { name: /^Model for/ })).not.toBeInTheDocument();
  await userEvent.click(tab("render"));
  // Without a project or group default, each member runs on its own model.
  const chip = () => main().getByRole("button", { name: /^Model for/ });
  await expect.element(chip()).toHaveTextContent("Members' models");
  const pick = async () => {
    await userEvent.click(chip());
    await userEvent.click(page.getByRole("option", { name: /GPT-5\.5/ }));
    await expect
      .element(main().getByRole("button", { name: "Model for this message, This message only" }))
      .toHaveTextContent("GPT-5.5");
    // Always in view, not only in a menu: the pick is for this message.
    await expect.element(main().getByText("This message", { exact: true })).toBeVisible();
  };
  const reset = main().getByRole("button", { name: "Use render's model" });
  await pick();
  await userEvent.click(reset);
  await expect.element(chip()).toHaveTextContent("Members' models");
  await expect.element(reset).not.toBeInTheDocument();
  // A pick lasts only in the tab it was made in.
  await pick();
  await userEvent.click(tab("All"));
  const all = localStorage.getItem(TAB_KEY)!;
  await userEvent.click(tab("render"));
  await expect.element(chip()).toHaveTextContent("Members' models");
  // A tab the user did not choose here (another window saved it) drops it for good too.
  await pick();
  const render = localStorage.getItem(TAB_KEY)!;
  const savedElsewhere = (value: string) => {
    localStorage.setItem(TAB_KEY, value);
    window.dispatchEvent(new StorageEvent("storage", { key: TAB_KEY }));
  };
  savedElsewhere(all);
  await expect.element(chip()).not.toBeInTheDocument();
  savedElsewhere(render);
  await expect.element(chip()).toHaveTextContent("Members' models");
  // It goes with the next send, then the chip shows the default again.
  await pick();
  await userEvent.type(composer(), "@bo go{Enter}");
  await eventually(() =>
    expect(fakeGroupChat.posts.at(-1)).toEqual({
      teamId: "t1",
      text: "@bo go",
      projectId: PROJECT_ID,
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
    }),
  );
  await expect.element(chip()).toHaveTextContent("Members' models");
  expect(fakeSettings.patches).toEqual([]);
});

it("saves the project's model from the group menu", async () => {
  fakeSettings.patches = [];
  fakeSettings.refuse = null;
  setFakeServerSettings(null);
  await using _screen = await openChat();
  await userEvent.click(main().getByRole("combobox", { name: "Project" }));
  await userEvent.click(page.getByRole("option", { name: "render" }));
  await userEvent.click(main().getByRole("button", { name: "Leadership actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Model in render" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Project's model" }));
  await expect.element(page.getByRole("dialog", { name: "Model in render" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Model for render/ }));
  await userEvent.click(page.getByRole("option", { name: /GPT-5\.5/ }));
  await eventually(() =>
    expect(fakeSettings.patches.at(-1)).toEqual({
      projectSettingsOverrides: {
        [PROJECT_ID]: { defaultModelSelection: { instanceId: "codex", model: "gpt-5.5" } },
      },
    }),
  );
});

it("shows the group's default for a project without its own", async () => {
  setFakeServerSettings(null);
  await using _screen = await openChat({
    team: team({
      defaultModelSelection: { instanceId: "codex" as ProviderInstanceId, model: "gpt-5.5" },
    }),
  });
  await userEvent.click(main().getByRole("combobox", { name: "Project" }));
  await userEvent.click(page.getByRole("option", { name: "render" }));
  await expect
    .element(main().getByRole("button", { name: "Model for render, Group default" }))
    .toHaveTextContent("GPT-5.5");
  // A member without an exception runs on the group's default there too.
  await userEvent.click(main().getByRole("button", { name: "Leadership actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Model in render" }));
  await userEvent.click(page.getByRole("menuitem", { name: /^Ada/ }));
  await expect
    .element(page.getByRole("button", { name: "Model for Ada" }))
    .toHaveTextContent("Group default");
});

it("says inline why the project's model was not saved and keeps the shown one", async () => {
  fakeSettings.patches = [];
  fakeSettings.refuse = "projectSettingsOverrides";
  setFakeServerSettings(null);
  await using _screen = await openChat();
  await userEvent.click(main().getByRole("combobox", { name: "Project" }));
  await userEvent.click(page.getByRole("option", { name: "render" }));
  await userEvent.click(main().getByRole("button", { name: "Leadership actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Model in render" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Project's model" }));
  const dialog = page.getByRole("dialog", { name: "Model in render" });
  await userEvent.click(dialog.getByRole("button", { name: /^Model for render/ }));
  await userEvent.click(page.getByRole("option", { name: /GPT-5\.5/ }));
  await expect
    .element(dialog.getByRole("alert"))
    .toHaveTextContent(
      "The provider instance codex does not exist or is disabled for this project.",
    );
  await expect
    .element(dialog.getByRole("button", { name: /^Model for render/ }))
    .toHaveTextContent("Members' models");
  fakeSettings.refuse = null;
});

it("sets a member's own model in the chosen project from the group menu, and removes it", async () => {
  fakeSettings.patches = [];
  fakeSettings.refuse = null;
  setFakeServerSettings(null);
  await using _screen = await openChat();
  const menu = () => main().getByRole("button", { name: "Leadership actions" });
  // Without a project there is nothing to set a member's model for.
  await userEvent.click(menu());
  await expect.element(page.getByRole("menuitem", { name: "Edit group" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: /^Model in/ })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(main().getByRole("combobox", { name: "Project" }));
  await userEvent.click(page.getByRole("option", { name: "render" }));
  await userEvent.click(menu());
  await userEvent.click(page.getByRole("menuitem", { name: "Model in render" }));
  await userEvent.click(page.getByRole("menuitem", { name: /^Ada/ }));
  await expect.element(page.getByText("No exception for Ada in this project.")).toBeVisible();
  // Without a project, group or own default, Ada runs on the user's default model.
  await expect
    .element(page.getByRole("button", { name: "Model for Ada" }))
    .toHaveTextContent("Your default model");
  await expect
    .element(page.getByRole("button", { name: "Remove exception" }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Model for Ada" }));
  await userEvent.click(page.getByRole("option", { name: /GPT-5\.5/ }));
  await eventually(() =>
    expect(fakeSettings.patches.at(-1)).toEqual({
      projectSettingsOverrides: {
        [PROJECT_ID]: {
          assistantModelSelections: { ada: { instanceId: "codex", model: "gpt-5.5" } },
        },
      },
    }),
  );
});

it("shows a member's exception in the group menu and removes it from its dialog", async () => {
  fakeSettings.patches = [];
  fakeSettings.refuse = null;
  setFakeServerSettings({
    projectSettingsOverrides: {
      [PROJECT_ID]: {
        assistantModelSelections: { ada: { instanceId: "codex", model: "gpt-5.5" } },
      },
    },
  } as never);
  // The config is read once per connection; start a fresh one so it carries the exception.
  appAtomRegistry.reset();
  await using _screen = await openChat();
  await userEvent.click(main().getByRole("combobox", { name: "Project" }));
  await userEvent.click(page.getByRole("option", { name: "render" }));
  await userEvent.click(main().getByRole("button", { name: "Leadership actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Model in render" }));
  await expect.element(page.getByRole("menuitem", { name: /^Ada.*GPT-5\.5/ })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: /^Bo.*No exception/ })).toBeVisible();
  await userEvent.click(page.getByRole("menuitem", { name: /^Ada/ }));
  await expect.element(page.getByText("Set for Ada in this project.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Remove exception" }));
  await eventually(() =>
    expect(fakeSettings.patches.at(-1)).toEqual({
      projectSettingsOverrides: { [PROJECT_ID]: { assistantModelSelections: { ada: null } } },
    }),
  );
  setFakeServerSettings(null);
});

it("inserts a mention from the Mention menu and dictates into the field", async () => {
  publishGroupChat([message(1)]);
  await using _screen = await openChat();
  await userEvent.click(main().getByRole("button", { name: "Mention" }));
  await userEvent.click(page.getByRole("menuitem", { name: /Bo/ }));
  await expectComposer("@bo ");
  await userEvent.click(main().getByRole("button", { name: "Dictate" }));
  await expectComposer("@bo dictated words");
  expect(speech.input?.offerSetup).toBe(true);
  await userEvent.click(main().getByRole("button", { name: "Submit message" }));
  await eventually(() =>
    expect(fakeGroupChat.posts).toEqual([{ teamId: "t1", text: "@bo dictated words" }]),
  );
});

it("asks for a project on a request the lead could not place, and routes it on a pick", async () => {
  publishGroupChat([
    message(1, { ...inRequest(1), text: "fix the login" }),
    message(2, {
      ...inRequest(1),
      kind: "notice",
      author: "assistant",
      assistantId: "jarvis" as AssistantId,
      text: "Which project is this for?",
      asksProject: true,
    }),
  ]);
  await using _screen = await openChat();
  await expect
    .element(blocks().first().getByTestId("group-request-status"))
    .toHaveTextContent("Needs project");
  await userEvent.click(
    main().getByTestId("group-request-projects").getByRole("button", { name: "render" }),
  );
  await eventually(() =>
    expect(fakeGroupChat.posts).toEqual([
      { teamId: "t1", text: "render", replyToMessageId: "m1", projectId: PROJECT_ID },
    ]),
  );
  // Replying to the whole request; with no project yet, the picker can still give it one.
  await userEvent.click(main().getByRole("button", { name: "Reply to request fix the login" }));
  await expect
    .element(main().getByTestId("group-reply-chip"))
    .toHaveTextContent("Replying to request: fix the login");
  await userEvent.click(main().getByRole("combobox", { name: "Project" }));
  await userEvent.click(page.getByRole("option", { name: "render" }));
  await userEvent.type(composer(), "@ada take it{Enter}");
  await eventually(() =>
    expect(fakeGroupChat.posts.at(-1)).toEqual({
      teamId: "t1",
      text: "@ada take it",
      replyToMessageId: "m1",
      projectId: PROJECT_ID,
    }),
  );
});

it("calls out a member waiting on the user, with a way to answer until it is resolved", async () => {
  const waitingNotice = (resolved: boolean) =>
    message(2, {
      ...inRequest(1),
      kind: "notice",
      author: "assistant",
      assistantId: "ada" as AssistantId,
      text: "Approve the transfer?",
      waiting: {
        threadId: `assistant:ada:g-${"2".repeat(16)}` as ThreadId,
        decisionId: "d-1" as never,
        resolved,
      },
    });
  publishGroupChat(
    [message(1, { ...inRequest(1), projectId: PROJECT_ID }), waitingNotice(false)],
    [task("t-1", 1, { requestId: "m1" as never })],
  );
  await using screen = await openChat();
  const callout = main().getByTestId("group-waiting");
  await expect.element(callout.getByText("Ada is waiting on you")).toBeVisible();
  await expect.element(callout.getByText("Approve the transfer?")).toBeVisible();
  await userEvent.click(callout.getByRole("button", { name: "Open decision" }));
  await eventually(() => expect(screen.router.state.location.pathname).toBe("/activity"));
  await screen.router.navigate({
    to: "/group/$environmentId/$teamId",
    params: { environmentId: ENVIRONMENT_ID, teamId: "t1" },
  });
  await userEvent.click(callout.getByRole("button", { name: "Open conversation" }));
  await eventually(() =>
    expect(screen.router.state.location.pathname).toContain(
      encodeURIComponent(`assistant:ada:g-${"2".repeat(16)}`),
    ),
  );
  await screen.router.navigate({
    to: "/group/$environmentId/$teamId",
    params: { environmentId: ENVIRONMENT_ID, teamId: "t1" },
  });
  publishGroupChat(
    [message(1, { ...inRequest(1), projectId: PROJECT_ID }), waitingNotice(true)],
    [task("t-1", 1, { requestId: "m1" as never })],
  );
  await expect.element(callout.getByText("Resolved")).toBeVisible();
  await expect.element(callout.getByText("Ada asked")).toBeVisible();
  await expect.element(callout.getByText("Ada is waiting on you")).not.toBeInTheDocument();
  await expect.element(callout.getByRole("button")).not.toBeInTheDocument();
});

it("opens an answer's file links against its task thread's worktree, else the request project's root", async () => {
  const boThread = `assistant:bo:g-${"0".repeat(16)}`;
  worktrees.set(boThread, "/worktrees/bo-plan");
  using _worktrees = { [Symbol.dispose]: () => worktrees.clear() };
  publishGroupChat(
    [
      message(1, { ...inRequest(1), projectId: PROJECT_ID, title: "Budget review" }),
      message(2, {
        ...inRequest(1),
        author: "assistant",
        assistantId: "ada" as AssistantId,
        taskId: "t-1" as never,
        text: "See [the plan](/workspace/render/src/plan.ts:7)",
      }),
      message(3, {
        ...inRequest(1),
        author: "assistant",
        assistantId: "bo" as AssistantId,
        taskId: "t-2" as never,
        text: "See [the notes](/worktrees/bo-plan/docs/notes.md)",
      }),
    ],
    [
      task("t-1", 1, { status: "running", requestId: "m1" as never }),
      task("t-2", 1, {
        status: "running",
        requestId: "m1" as never,
        ownerId: "bo" as AssistantId,
        threadId: boThread as never,
      }),
    ],
  );
  await using _screen = await openChat();
  using openFile = vi.spyOn(useRightPanelStore.getState(), "openFile").mockImplementation(() => {});
  const link = main()
    .getByTestId("group-answer")
    .getByRole("link", { name: /plan\.ts/ });
  await expect.element(link).toHaveAttribute("href", "/workspace/render/src/plan.ts:7");
  await userEvent.click(link);
  await eventually(() =>
    expect(openFile).toHaveBeenCalledExactlyOnceWith(
      { environmentId: ENVIRONMENT_ID, threadId: `assistant:ada:g-${"0".repeat(16)}` },
      "src/plan.ts",
      7,
    ),
  );
  await userEvent.click(main().getByRole("link", { name: /notes\.md/ }));
  await eventually(() =>
    expect(openFile).toHaveBeenLastCalledWith(
      { environmentId: ENVIRONMENT_ID, threadId: boThread },
      "docs/notes.md",
      undefined,
    ),
  );
});

it("shows a cancelled task as one activity line and no card", async () => {
  publishGroupChat(
    [message(1, { ...inRequest(1), projectId: PROJECT_ID, title: "Budget review" })],
    [task("t-1", 1, { status: "cancelled", requestId: "m1" as never })],
  );
  await using _screen = await openChat();
  await expect
    .element(main().getByRole("button", { name: "Open task instruction of t-1" }))
    .toHaveAttribute("data-task-event-activity", "cancelled");
  await expect.element(main().getByText("Cancelled")).toBeVisible();
  await expect.element(main().getByTestId("group-task-card")).not.toBeInTheDocument();
});

it("scrolls the feed when the wheel turns over the minimap", async () => {
  publishGroupChat(
    [
      message(1, { ...inRequest(1), projectId: PROJECT_ID, title: "Budget review" }),
      message(2, { ...inRequest(2), projectId: PROJECT_ID, title: "Ship the app" }),
      message(3, {
        ...inRequest(2),
        text: Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n\n"),
      }),
    ],
    [task("t-2", 2, { requestId: "m2" as never })],
  );
  await using _screen = await openChat();
  const scroller = document
    .querySelector<HTMLElement>('[data-testid="group-request-block"]')!
    .closest<HTMLElement>(".overflow-y-auto")!;
  const before = scroller.scrollTop;
  const minimap = document.querySelector<HTMLElement>('[data-testid="timeline-minimap"]')!;
  // Chromium's legacy wheelDeltaY marks a trackpad delta; WheelEventInit does not declare it.
  const init = { cancelable: true, deltaY: -40, wheelDeltaY: 40 };
  minimap.dispatchEvent(new WheelEvent("wheel", init));
  await eventually(() => expect(scroller.scrollTop).toBeLessThan(before));
});
