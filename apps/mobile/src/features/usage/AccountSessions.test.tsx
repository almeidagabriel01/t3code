import type { UsageSession } from "@t3tools/client-runtime/state/usageSessions";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: {
    accessibilityRole?: string;
    onPress?: () => void;
    children?: ReactNode;
  }) => <button onClick={props.onPress}>{props.children}</button>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));

import { AccountSessions } from "./AccountSessions";

const session = (title: string, state: UsageSession["state"]) =>
  ({
    environmentId: "env",
    threadId: title,
    projectKey: "env:p",
    title,
    state,
    model: "m",
    elapsed: "1m",
  }) as unknown as UsageSession;

async function mount(sessions: ReadonlyArray<UsageSession>, onOpen = vi.fn()) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = window.document.createElement("div");
  const root = createRoot(container);
  await act(() =>
    root.render(
      <AccountSessions
        sessions={sessions}
        projectTitles={new Map([["env:p", "Project"]])}
        onOpen={onOpen}
      />,
    ),
  );
  return { container, root, onOpen };
}

const text = (container: HTMLElement) => container.textContent ?? "";

describe("AccountSessions", () => {
  it("counts only running threads and keeps finished ones collapsed until opened", async () => {
    const { container, root, onOpen } = await mount([
      session("live", "working"),
      session("done-1", "recent"),
      session("done-2", "recent"),
    ]);
    expect(text(container)).toContain("Sessions · 1 running");
    expect(text(container)).toContain("live");
    expect(text(container)).toContain("Finished · 2");
    expect(text(container)).not.toContain("done-1");

    const finished = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Finished"),
    )!;
    await act(async () => finished.click());
    expect(text(container)).toContain("done-1");

    const row = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("done-2"),
    )!;
    await act(async () => row.click());
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ title: "done-2" }));
    await act(() => root.unmount());
  });

  it("drops the count when nothing runs and renders nothing without sessions", async () => {
    const idle = await mount([session("done", "recent")]);
    expect(text(idle.container)).toMatch(/^SessionsFinished · 1$/);
    await act(() => idle.root.unmount());
    const none = await mount([]);
    expect(text(none.container)).toBe("");
    await act(() => none.root.unmount());
  });
});
