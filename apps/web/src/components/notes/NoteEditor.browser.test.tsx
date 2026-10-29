import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { NoteEditor } from "./NoteEditor";

const mocks = vi.hoisted(() => ({ upload: vi.fn() }));

vi.mock("../../lib/attachmentUploadQueue", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploadStandaloneAttachment: mocks.upload,
}));
vi.mock("../../assets/assetUrls", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAssetUrlState: () => ({ _tag: "Initial" }),
}));

function setup() {
  let finish!: (value: { attachmentId: string }) => void;
  mocks.upload.mockReset().mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  return { finish: (attachmentId: string) => finish({ attachmentId }) };
}

describe("NoteEditor images", () => {
  it("shows a pasted image at once and saves its ref once the upload lands", async () => {
    const upload = setup();
    const onChange = vi.fn();
    await using _screen = await render(
      <NoteEditor
        environmentId={EnvironmentId.make("env")}
        body={"# Plan\n"}
        editable
        autoFocus
        onChange={onChange}
      />,
    );
    const body = page.getByRole("textbox", { name: "Note body" });
    await expect.element(body).toBeVisible();

    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }),
    );
    body
      .element()
      .dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );

    const preview = page.getByRole("img", { name: "shot.png" });
    await expect.element(preview).toBeVisible();
    expect(preview.element().getAttribute("src")).toMatch(/^blob:/);
    await expect.element(page.getByLabelText("Uploading shot.png")).toBeVisible();
    // An image without an id yet must not reach the file.
    expect(onChange.mock.calls.flat().join("\n")).not.toContain("t3-attachment");

    upload.finish("pending-11111111-1111-4111-8111-111111111111");
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        expect.stringContaining(
          "![shot.png](t3-attachment:pending-11111111-1111-4111-8111-111111111111)",
        ),
      ),
    );
    expect(onChange.mock.lastCall?.[0]).toMatch(/^# Plan\n\n/);
  });
});

describe("NoteEditor formatting", () => {
  it("turns an empty block into a heading from the slash menu", async () => {
    const onChange = vi.fn();
    await using _screen = await render(
      <NoteEditor
        environmentId={EnvironmentId.make("env")}
        body=""
        editable
        autoFocus
        onChange={onChange}
      />,
    );
    const body = page.getByRole("textbox", { name: "Note body" });
    await expect.element(body).toBeVisible();
    await userEvent.type(body, "/head");
    await expect.element(page.getByRole("option", { name: "Heading 2" })).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{Enter}Plan");
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("## Plan"));
  });
});

describe("NoteEditor lists", () => {
  const props = { environmentId: EnvironmentId.make("env"), editable: true, autoFocus: true };

  it.each([
    ["* one", "bullet"],
    ["1) one", "ordered"],
    ["+ [X] one", "task"],
  ])("renders %j as a real list and Enter continues it", async (source) => {
    const onChange = vi.fn();
    await using _screen = await render(
      <NoteEditor {...props} body={`${source}\n`} onChange={onChange} />,
    );
    const body = page.getByRole("textbox", { name: "Note body" });
    await expect.element(body).toBeVisible();
    expect(body.element().querySelector("pre[data-note-raw]")).toBeNull();
    expect(body.element().querySelectorAll("li")).toHaveLength(1);
    await userEvent.keyboard("{Enter}two");
    expect(body.element().querySelectorAll("li")).toHaveLength(2);
    await vi.waitFor(() => expect(onChange.mock.lastCall?.[0]).toMatch(/\n.+two/));
  });

  it("keeps Shift+Enter inside the item as a line break", async () => {
    await using _screen = await render(
      <NoteEditor {...props} body={"- one\n"} onChange={vi.fn()} />,
    );
    const body = page.getByRole("textbox", { name: "Note body" });
    await expect.element(body).toBeVisible();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}two");
    expect(body.element().querySelectorAll("li")).toHaveLength(1);
    expect(body.element().querySelectorAll("li br")).toHaveLength(1);
  });
});

describe("NoteEditor literal blocks", () => {
  it("keeps Shift+Enter inside the literal block", async () => {
    const onChange = vi.fn();
    await using _screen = await render(
      <NoteEditor
        environmentId={EnvironmentId.make("env")}
        body={"<div>one</div>\n"}
        editable
        autoFocus
        onChange={onChange}
      />,
    );
    const body = page.getByRole("textbox", { name: "Note body" });
    await expect.element(body).toBeVisible();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}two");
    expect(body.element().querySelectorAll("pre[data-note-raw]")).toHaveLength(1);
    expect(body.element().querySelectorAll("p")).toHaveLength(0);
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("<div>one</div>\ntwo\n"));
  });
});

describe("NoteEditor view mode", () => {
  const checklist = "- [ ] ship it\n";

  it("shows no formatting toolbar and takes no typing until editable", async () => {
    const onChange = vi.fn();
    const props = { environmentId: EnvironmentId.make("env"), body: "# Plan\n", onChange };
    await using screen = await render(<NoteEditor {...props} editable={false} />);
    const body = page.getByRole("textbox", { name: "Note body" });
    await expect.element(body).toBeVisible();
    expect(body.element().getAttribute("contenteditable")).toBe("false");
    await expect
      .element(page.getByRole("toolbar", { name: "Note formatting" }))
      .not.toBeInTheDocument();
    await screen.rerender(<NoteEditor {...props} editable />);
    await expect.element(page.getByRole("toolbar", { name: "Note formatting" })).toBeVisible();
    expect(body.element().getAttribute("contenteditable")).toBe("true");
  });

  it("saves a checkbox toggled while reading", async () => {
    const onChange = vi.fn();
    await using _screen = await render(
      <NoteEditor
        environmentId={EnvironmentId.make("env")}
        body={checklist}
        editable={false}
        onChange={onChange}
      />,
    );
    await userEvent.click(page.getByRole("checkbox"));
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("- [x] ship it\n"));
  });
});
