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
