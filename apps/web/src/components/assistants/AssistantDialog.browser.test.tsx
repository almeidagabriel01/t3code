import { createMemoryHistory } from "@tanstack/react-router";
import type {
  Assistant,
  AssistantId,
  AssistantTeam,
  AssistantTeamId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { getRouter } from "~/router";
import { assistantDialogAtom, openAssistantDialog } from "./assistantDialogState";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  fakeAssistantEdits,
  fakeTeamEdits,
  installFakeEnvironment,
  publishAssistants,
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
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));
const uploads = vi.hoisted(() => ({ calls: [] as File[], fail: false }));
vi.mock(import("~/lib/attachmentUploadQueue"), async (original) => ({
  ...(await original()),
  uploadStandaloneAttachment: async (_environmentId, file) => {
    uploads.calls.push(file);
    if (uploads.fail) throw new Error("Upload failed");
    return { attachmentId: "att-1", mimeType: file.type };
  },
}));
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (_environmentId, resource) =>
    resource === null
      ? { _tag: "Loading" }
      : { _tag: "Success", url: PIXEL, expiresAt: Number.MAX_SAFE_INTEGER },
}));

installFakeEnvironment([threadWithHistory("thread-a", 2)], {
  assistants: true,
  reasoningEffort: true,
});
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const assistant = (id: string, name: string, overrides: Partial<Assistant> = {}): Assistant => ({
  id: id as AssistantId,
  handle: id,
  name,
  projectId: PROJECT_ID,
  projectIds: [],
  instructions: "",
  toolAccess: "full",
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
  createdAt: "2026-03-17T19:00:00.000Z",
  updatedAt: "2026-03-17T19:00:00.000Z",
  ...overrides,
});

const team = (id: string, name: string, memberIds: string[], leadId?: string): AssistantTeam => ({
  id: id as AssistantTeamId,
  name,
  memberIds: memberIds as AssistantId[],
  leadId: (leadId ?? null) as AssistantId | null,
  archivedAt: null,
  createdAt: "2026-03-17T19:00:00.000Z",
  updatedAt: "2026-03-17T19:00:00.000Z",
});

const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

async function openApp() {
  appAtomRegistry.set(assistantDialogAtom, null);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/settings/assistants"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return render(<AppRoot router={router} />, { container, router: false });
}

const openAdvanced = () => userEvent.click(page.getByRole("button", { name: "Advanced" }));
const file = (name: string, type: string, bytes = 8) =>
  new File([new Uint8Array(bytes)], name, { type });
const chooseImage = (image: File) =>
  userEvent.upload(page.getByLabelText("Avatar image file"), image);

it("a new assistant starts with the basics, Advanced closed and the safe defaults", async () => {
  fakeAssistantEdits.creates = [];
  fakeAssistantEdits.created = assistant("scout", "Scout");
  publishAssistants([assistant("jarvis", "Jarvis")]);
  await using _screen = await openApp();
  openAssistantDialog();
  await expect.element(page.getByLabelText("Name")).toBeVisible();
  await expect.element(page.getByText("Its role and rules, in your words.")).toBeVisible();
  await expect.element(page.getByLabelText("What should it do?")).toBeVisible();
  // The second assistant starts on its own color, not the first one's.
  await expect.element(page.getByRole("radio", { name: "Color 30" })).toBeChecked();
  expect(page.getByLabelText("Handle").query()).toBeNull();
  expect(page.getByRole("radio", { name: /Full access/ }).query()).toBeNull();
  await expect
    .element(
      page.getByText(/Edit files · This Mac · no spending limit · no connectors · asks before/),
    )
    .toBeVisible();

  await userEvent.fill(page.getByLabelText("Name"), "Scout");
  await userEvent.fill(page.getByLabelText("What should it do?"), "Research things");
  await userEvent.click(page.getByRole("radio", { name: "Color 280" }));
  await userEvent.click(page.getByRole("button", { name: "Shuffle" }));
  await userEvent.click(page.getByRole("button", { name: "Create assistant" }));
  await eventually(() =>
    expect(fakeAssistantEdits.creates).toMatchObject([
      {
        name: "Scout",
        instructions: "Research things",
        toolAccess: "workspace-write",
        askBeforeActing: true,
        avatar: { kind: "robot", hue: 280, variant: 4 },
      },
    ]),
  );
  expect(fakeAssistantEdits.creates[0]).not.toHaveProperty("workspace");
  expect(fakeAssistantEdits.creates[0]).not.toHaveProperty("budget");
  expect(fakeAssistantEdits.creates[0]).not.toHaveProperty("mcpServers");
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("the Advanced summary follows the choices and opens to the full settings", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  await using _screen = await openApp();
  openAssistantDialog();
  await openAdvanced();
  await expect.element(page.getByLabelText("Handle")).toBeVisible();
  await userEvent.click(page.getByRole("radio", { name: /Read only/ }));
  await userEvent.click(page.getByRole("switch", { name: "Ask before acting" }));
  await userEvent.click(page.getByRole("switch", { name: "Limit spending" }));
  await userEvent.fill(page.getByLabelText("Amount (USD)"), "7");
  await openAdvanced();
  await expect
    .element(page.getByText(/Read only · This Mac · \$7 limit · no connectors · messages other/))
    .toBeVisible();
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("uploads a picked image after the assistant is created, then sets it", async () => {
  uploads.calls = [];
  uploads.fail = false;
  fakeAssistantEdits.creates = [];
  fakeAssistantEdits.avatarImages = [];
  fakeAssistantEdits.created = assistant("scout", "Scout");
  publishAssistants([fakeAssistantEdits.created]);
  await using _screen = await openApp();
  openAssistantDialog();
  await userEvent.fill(page.getByLabelText("Name"), "Scout");
  await chooseImage(file("me.png", "image/png"));
  await expect.element(page.getByRole("img", { name: "Chosen avatar" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Create assistant" }));
  await eventually(() =>
    expect(fakeAssistantEdits.avatarImages).toMatchObject([
      { assistantId: "scout", attachmentId: "att-1" },
    ]),
  );
  expect(uploads.calls.map((call) => call.name)).toEqual(["me.png"]);
  expect(fakeAssistantEdits.creates[0]).not.toHaveProperty("avatar");
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("a chosen file can be taken back before saving", async () => {
  uploads.calls = [];
  fakeAssistantEdits.creates = [];
  fakeAssistantEdits.created = assistant("scout", "Scout");
  publishAssistants([fakeAssistantEdits.created]);
  await using _screen = await openApp();
  openAssistantDialog();
  await userEvent.fill(page.getByLabelText("Name"), "Scout");
  await chooseImage(file("me.png", "image/png"));
  await userEvent.click(page.getByRole("button", { name: "Remove image" }));
  expect(page.getByRole("img", { name: "Chosen avatar" }).query()).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Create assistant" }));
  await eventually(() =>
    expect(fakeAssistantEdits.creates).toMatchObject([{ avatar: { kind: "robot" } }]),
  );
  expect(uploads.calls).toEqual([]);
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("reports a failed upload without losing the saved assistant", async () => {
  uploads.calls = [];
  uploads.fail = true;
  fakeAssistantEdits.avatarImages = [];
  fakeAssistantEdits.created = assistant("scout", "Scout");
  publishAssistants([fakeAssistantEdits.created]);
  await using _screen = await openApp();
  openAssistantDialog();
  await userEvent.fill(page.getByLabelText("Name"), "Scout");
  await chooseImage(file("me.png", "image/png"));
  await userEvent.click(page.getByRole("button", { name: "Create assistant" }));
  await expect.element(page.getByText("Scout was saved, but not everything")).toBeVisible();
  expect(fakeAssistantEdits.avatarImages).toEqual([]);
  uploads.fail = false;
  appAtomRegistry.set(assistantDialogAtom, null);
});

it.each([
  ["a wrong type", file("notes.txt", "text/plain"), "Use a PNG, JPEG or WebP image."],
  [
    "a file over 2 MB",
    file("big.png", "image/png", 2 * 1024 * 1024 + 1),
    "The image must be under 2 MB.",
  ],
])("refuses %s before anything is uploaded", async (_name, bad, message) => {
  uploads.calls = [];
  publishAssistants([assistant("jarvis", "Jarvis")]);
  await using _screen = await openApp();
  openAssistantDialog();
  await chooseImage(bad);
  await expect.element(page.getByRole("alert")).toHaveTextContent(message);
  expect(page.getByRole("img", { name: "Chosen avatar" }).query()).toBeNull();
  expect(uploads.calls).toEqual([]);
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("edits a robot's color and sends only the avatar", async () => {
  fakeAssistantEdits.updates = [];
  publishAssistants([assistant("jarvis", "Jarvis", { avatar: { kind: "robot", hue: 150 } })]);
  await using _screen = await openApp();
  openAssistantDialog({ environmentId: ENVIRONMENT_ID, assistantId: "jarvis" as AssistantId });
  await expect.element(page.getByRole("radio", { name: "Color 150" })).toBeChecked();
  await userEvent.click(page.getByRole("radio", { name: "Color 280" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      { assistantId: "jarvis", avatar: { kind: "robot", hue: 280, variant: 0 } },
    ]),
  );
  expect(fakeAssistantEdits.updates[0]).not.toHaveProperty("icon");
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("removes an uploaded image by going back to the robot", async () => {
  fakeAssistantEdits.updates = [];
  publishAssistants([assistant("jarvis", "Jarvis", { avatar: { kind: "image", revision: 3 } })]);
  await using _screen = await openApp();
  openAssistantDialog({ environmentId: ENVIRONMENT_ID, assistantId: "jarvis" as AssistantId });
  await eventually(() =>
    expect(document.querySelector("[data-avatar-image-preview] img")).not.toBeNull(),
  );
  await userEvent.click(page.getByRole("button", { name: "Remove image" }));
  expect(page.getByRole("button", { name: "Remove image" }).query()).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      { assistantId: "jarvis", avatar: { kind: "robot" } },
    ]),
  );
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("an unchanged assistant keeps its avatar out of the update", async () => {
  fakeAssistantEdits.updates = [];
  publishAssistants([assistant("jarvis", "Jarvis", { icon: "scout" })]);
  await using _screen = await openApp();
  openAssistantDialog({ environmentId: ENVIRONMENT_ID, assistantId: "jarvis" as AssistantId });
  await userEvent.fill(page.getByLabelText("Name"), "Jarvis 2");
  // A server without assistant default models sends no field, so there is nothing to edit.
  expect(page.getByText("Default model").query()).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() => expect(fakeAssistantEdits.updates).toHaveLength(1));
  expect(fakeAssistantEdits.updates[0]).not.toHaveProperty("avatar");
  expect(fakeAssistantEdits.updates[0]).not.toHaveProperty("icon");
  expect(fakeAssistantEdits.updates[0]).not.toHaveProperty("defaultModelSelection");
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("clears an assistant's own default model back to the user's default", async () => {
  fakeAssistantEdits.updates = [];
  publishAssistants([
    assistant("jarvis", "Jarvis", {
      defaultModelSelection: { instanceId: "codex" as never, model: "gpt-5.5" },
    }),
  ]);
  await using _screen = await openApp();
  openAssistantDialog({ environmentId: ENVIRONMENT_ID, assistantId: "jarvis" as AssistantId });
  await expect
    .element(page.getByRole("button", { name: "Assistant default model" }))
    .toHaveTextContent("GPT-5.5");
  await userEvent.click(page.getByRole("button", { name: "Use your default" }));
  await expect.element(page.getByText("Follows your default model, GPT-5.4.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      { assistantId: "jarvis", defaultModelSelection: null },
    ]),
  );
  expect(fakeAssistantEdits.updates[0]).not.toHaveProperty("modelSelection");
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("replaces a stored image with a new file", async () => {
  uploads.calls = [];
  fakeAssistantEdits.updates = [];
  fakeAssistantEdits.avatarImages = [];
  publishAssistants([assistant("jarvis", "Jarvis", { avatar: { kind: "image", revision: 1 } })]);
  await using _screen = await openApp();
  openAssistantDialog({ environmentId: ENVIRONMENT_ID, assistantId: "jarvis" as AssistantId });
  await chooseImage(file("new.webp", "image/webp"));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.avatarImages).toMatchObject([{ assistantId: "jarvis" }]),
  );
  expect(fakeAssistantEdits.updates[0]).not.toHaveProperty("avatar");
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("starts in the project the sidebar asked for", async () => {
  fakeAssistantEdits.creates = [];
  fakeAssistantEdits.created = assistant("scout", "Scout", { scope: "project" });
  publishAssistants([assistant("jarvis", "Jarvis")]);
  await using _screen = await openApp();
  openAssistantDialog({ preset: { projectId: PROJECT_ID as ProjectId } });
  await expect.element(page.getByRole("checkbox", { name: "render" })).toBeChecked();
  await userEvent.fill(page.getByLabelText("Name"), "Scout");
  await userEvent.click(page.getByRole("button", { name: "Create assistant" }));
  await eventually(() =>
    expect(fakeAssistantEdits.creates).toMatchObject([{ projectId: PROJECT_ID }]),
  );
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("joins the groups it is ticked into, leaves others and hands back a lead", async () => {
  fakeAssistantEdits.created = assistant("scout", "Scout");
  fakeTeamEdits.updates = [];
  publishAssistants(
    [assistant("jarvis", "Jarvis"), assistant("ana", "Ana")],
    [team("t1", "Leaders", ["jarvis", "ana"], "jarvis"), team("t2", "Research", ["ana"])],
  );
  await using _screen = await openApp();
  openAssistantDialog({ environmentId: ENVIRONMENT_ID, assistantId: "jarvis" as AssistantId });
  await expect.element(page.getByRole("checkbox", { name: "Leaders" })).toBeChecked();
  await expect.element(page.getByRole("checkbox", { name: "Research" })).not.toBeChecked();
  await userEvent.click(page.getByRole("checkbox", { name: "Leaders" }));
  await userEvent.click(page.getByRole("checkbox", { name: "Research" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeTeamEdits.updates).toMatchObject([
      { teamId: "t1", memberIds: ["ana"], leadId: null },
      { teamId: "t2", memberIds: ["ana", "jarvis"] },
    ]),
  );
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("a new assistant starts in the group it was created from", async () => {
  fakeAssistantEdits.creates = [];
  fakeTeamEdits.updates = [];
  fakeAssistantEdits.created = assistant("scout", "Scout");
  publishAssistants([assistant("ana", "Ana")], [team("t2", "Research", ["ana"])]);
  await using _screen = await openApp();
  openAssistantDialog({ preset: { teamId: "t2" as AssistantTeamId } });
  await expect.element(page.getByRole("checkbox", { name: "Research" })).toBeChecked();
  await userEvent.fill(page.getByLabelText("Name"), "Scout");
  await userEvent.click(page.getByRole("button", { name: "Create assistant" }));
  await eventually(() =>
    expect(fakeTeamEdits.updates).toMatchObject([{ teamId: "t2", memberIds: ["ana", "scout"] }]),
  );
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("says so when there are no groups yet", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  await using _screen = await openApp();
  openAssistantDialog();
  await expect
    .element(page.getByText("No groups yet. Create one from the Assistants page."))
    .toBeVisible();
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("shows an uploaded image as the assistant's avatar, and the robot again if it fails to load", async () => {
  publishAssistants([assistant("jarvis", "Jarvis", { avatar: { kind: "image", revision: 2 } })]);
  await using _screen = await openApp();
  await eventually(() =>
    expect(document.querySelector("[data-assistant-avatar-image]")?.getAttribute("src")).toBe(
      PIXEL,
    ),
  );
  for (const image of document.querySelectorAll("[data-assistant-avatar-image]")) {
    image.dispatchEvent(new Event("error"));
  }
  await eventually(() =>
    expect(document.querySelector("[data-assistant-avatar-image]")).toBeNull(),
  );
});
