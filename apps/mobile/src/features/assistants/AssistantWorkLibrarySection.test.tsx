import type { Assistant } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: { library: { data: null, error: null } as { data: unknown; error: string | null } },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <p>
      {props.label} {props.description}
    </p>
  ),
}));
vi.mock("../../state/assistants", () => ({ useAssistantLibrary: () => mocks.library }));

import { AssistantWorkLibrarySection } from "./AssistantWorkLibrarySection";

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(() =>
    root.render(
      <AssistantWorkLibrarySection
        environmentId={"hub" as never}
        assistant={{ id: "ada" } as unknown as Assistant}
      />,
    ),
  );
const file = (name: string, direction: "sent" | "received", from: string | null, size: number) => ({
  name,
  path: `/shared/${name}`,
  size,
  direction,
  from,
  savedAt: "2026-11-01T12:00:00.000Z",
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

describe("AssistantWorkLibrarySection", () => {
  it("lists what it sent and received with sizes", () => {
    mocks.library = {
      data: {
        files: [
          file("report.pdf", "sent", null, 2048),
          file("notes.md", "received", "Grace", 12),
          file("video.mov", "received", null, 5 * 1024 * 1024),
        ],
        truncated: true,
      },
      error: null,
    };
    render();
    const text = container.textContent!;
    expect(text).toContain("report.pdf Sent · 2 KB");
    expect(text).toContain("notes.md Received from Grace · 12 B");
    expect(text).toContain("video.mov Received · 5.0 MB");
    expect(text).toContain("Showing the newest files.");
  });

  it.each([
    ["loading", { data: null, error: null }, "Loading its files."],
    ["empty", { data: { files: [], truncated: false }, error: null }, "No files yet."],
    ["failed", { data: null, error: "Server said no" }, "Could not load its files: Server said no"],
  ] as const)("%s", (_name, library, message) => {
    mocks.library = library as never;
    render();
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain("Showing the newest files.");
  });
});
