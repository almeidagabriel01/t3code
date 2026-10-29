import type { NoteDocument } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { NoteConflictDialog } from "./NoteConflictDialog";
import type { NoteEditState } from "./noteState";

const document = (body: string, revision: string): NoteDocument => ({
  id: null,
  path: "plan.md",
  folder: null,
  title: "Plan",
  body,
  pinned: false,
  preview: "",
  related: [],
  card: null,
  updatedBy: "agent",
  revision,
  updatedAt: "2026-01-01T00:00:00.000Z",
  size: body.length,
});

const state = (draft: string, theirs: string): NoteEditState => ({
  document: document("# Plan\n- [ ] Ship\n", "a".repeat(64)),
  body: draft,
  incoming: document(theirs, "b".repeat(64)),
  saving: false,
  refreshing: false,
  refreshError: null,
  error: null,
  editorVersion: 0,
  claimedImages: new Map(),
});

describe("NoteConflictDialog", () => {
  it("marks the lines only the file has and the lines only the draft has", async () => {
    await using _screen = await render(
      <NoteConflictDialog
        state={state("# Plan\n- [ ] Ship\n- [ ] Write docs\n", "# Plan\n- [x] Ship\n")}
        open
        canWrite
        onOpenChange={vi.fn()}
        onTheirs={vi.fn()}
        onMine={vi.fn()}
      />,
    );
    const current = page.getByLabelText("Current file");
    const draft = page.getByLabelText("Your draft");
    await expect.element(current).toBeVisible();
    const marked = (column: typeof current, kind: string) =>
      [...column.element().querySelectorAll(`[data-change=${kind}]`)].map(
        (line) => line.textContent,
      );
    expect(marked(current, "removed")).toEqual(["- [x] Ship"]);
    expect(marked(draft, "added")).toEqual(["- [ ] Ship", "- [ ] Write docs"]);
    expect(marked(current, "unchanged")).toEqual(["# Plan", " "]);
  });

  it("stays closed when nothing changed elsewhere", async () => {
    await using _screen = await render(
      <NoteConflictDialog
        state={{ ...state("a", "b"), incoming: null }}
        open
        canWrite
        onOpenChange={vi.fn()}
        onTheirs={vi.fn()}
        onMine={vi.fn()}
      />,
    );
    await expect.element(page.getByText("This note changed")).not.toBeInTheDocument();
  });
});
