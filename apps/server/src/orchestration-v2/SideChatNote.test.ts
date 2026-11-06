import { it as effectIt } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  SIDE_CHAT_NOTE,
  type SideChatParentReader,
  sideChatNote,
  sideChatNoteFor,
} from "./SideChatNote.ts";
import { ProjectionStoreReadError } from "./ProjectionStore.ts";
import type { SideChatParentSnapshot } from "./SideChatParentContext.ts";

const parentId = ThreadId.make("thread:parent");
const side = {
  lineage: { parentThreadId: parentId, sideChat: true },
};
const ordinary = {
  lineage: { parentThreadId: null },
};

describe("sideChatNoteFor", () => {
  const parentContext = "<parent_thread>\nTitle: Nightly\n</parent_thread>";

  it("marks every side-chat prompt with the boundary followed by the parent's live state", () => {
    expect(sideChatNoteFor(side, "what was that config file?", parentContext)).toBe(
      `${SIDE_CHAT_NOTE}\n\n${parentContext}`,
    );
  });

  it("lets the side agent send to the main thread only on the user's explicit ask", () => {
    expect(SIDE_CHAT_NOTE).toContain("Do not launch threads, delegate tasks, or schedule work");
    expect(SIDE_CHAT_NOTE).toContain("explicitly asks to send or forward something to the main");
    expect(SIDE_CHAT_NOTE).toContain("t3_thread_send");
  });

  it("leaves ordinary threads alone", () => {
    expect(sideChatNoteFor(ordinary, "continue", parentContext)).toBe("");
    expect(
      sideChatNoteFor(
        { lineage: { parentThreadId: parentId, sideChat: false } },
        "continue",
        parentContext,
      ),
    ).toBe("");
  });

  it("keeps provider slash commands at the start of the prompt", () => {
    expect(sideChatNoteFor(side, "  /compact", parentContext)).toBe("");
  });
});

describe("sideChatNote", () => {
  const message = (role: "user" | "assistant", text: string) => ({
    role,
    text,
    streaming: false,
    createdAt: DateTime.makeUnsafe("2026-10-24T07:30:00.000Z"),
  });
  const parentReader = (parent: { current: SideChatParentSnapshot }) => {
    const reads: Array<ThreadId> = [];
    const reader: SideChatParentReader = {
      getThreadShell: (threadId) => Effect.sync(() => (reads.push(threadId), parent.current.shell)),
      getThreadRecords: () => Effect.sync(() => parent.current),
    };
    return { reader, reads };
  };

  effectIt.effect(
    "reads the parent again on every turn, so the side chat follows its progress",
    () =>
      Effect.gen(function* () {
        const parent: { current: SideChatParentSnapshot } = {
          current: {
            shell: {
              title: "Nightly #1111",
              status: "running",
              latestRunStopRequested: false,
              pendingRuntimeRequest: null,
              goal: { objective: "Ship nightly #1111", status: "active" },
              branch: "t3/nightly-1111",
              worktreePath: null,
              lastError: null,
            },
            messages: [message("user", "Ship #1111 to nightly")],
            plans: [],
          },
        };
        const { reader, reads } = parentReader(parent);

        const first = yield* sideChatNote(reader, side, "지금 뭐하고 있는거임");
        expect(first.startsWith(SIDE_CHAT_NOTE)).toBe(true);
        expect(first).toContain("Status: running a turn right now");
        expect(first).toContain("Goal (active): Ship nightly #1111");

        parent.current = {
          ...parent.current,
          shell: {
            ...parent.current.shell,
            status: "interrupted",
            goal: { objective: "Ship nightly #1111", status: "paused" },
          },
          messages: [...parent.current.messages, message("user", "계속")],
        };
        const second = yield* sideChatNote(reader, side, "now?");
        expect(second).toContain("Status: idle, its latest turn was interrupted by the user");
        expect(second).toContain("Goal (paused): Ship nightly #1111");
        expect(second).toContain("] 계속");
        expect(reads).toEqual([parentId, parentId]);
      }),
  );

  effectIt.effect("still sends the boundary and says so when the parent cannot be read", () =>
    Effect.gen(function* () {
      const reader: SideChatParentReader = {
        getThreadShell: (threadId) => Effect.fail(new ProjectionStoreReadError({ threadId })),
        getThreadRecords: () => Effect.die("unreachable"),
      };
      const note = yield* sideChatNote(reader, side, "status?");
      expect(note.startsWith(SIDE_CHAT_NOTE)).toBe(true);
      expect(note).toContain("could not be read");
    }),
  );

  effectIt.effect("sends only the boundary on the first turn, without reading the parent", () =>
    Effect.gen(function* () {
      const reader: SideChatParentReader = {
        getThreadShell: () => Effect.die("the digest already covers the parent"),
        getThreadRecords: () => Effect.die("the digest already covers the parent"),
      };
      expect(yield* sideChatNote(reader, side, "what is going on?", true)).toBe(SIDE_CHAT_NOTE);
    }),
  );

  effectIt.effect("does not read anything for ordinary threads", () =>
    Effect.gen(function* () {
      const reader: SideChatParentReader = {
        getThreadShell: () => Effect.die("ordinary threads have no parent"),
        getThreadRecords: () => Effect.die("ordinary threads have no parent"),
      };
      expect(yield* sideChatNote(reader, ordinary, "continue")).toBe("");
      expect(yield* sideChatNote(reader, side, "/compact")).toBe("");
    }),
  );
});
