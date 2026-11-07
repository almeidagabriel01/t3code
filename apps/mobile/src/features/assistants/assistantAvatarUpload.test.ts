import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({ mocks: { pick: vi.fn(), prepare: vi.fn() } }));
vi.mock("../../lib/composerImages", () => ({ pickComposerImages: mocks.pick }));
vi.mock("../../lib/attachmentUpload", () => ({ prepareTurnAttachments: mocks.prepare }));

import { pickAvatarImage, uploadAvatarImage } from "./assistantAvatarUpload";

const image = (mimeType: string, sizeBytes: number) => ({ mimeType, sizeBytes, name: "a" });

beforeEach(() => {
  mocks.pick.mockReset();
  mocks.prepare.mockReset();
});

describe("pickAvatarImage", () => {
  it("returns the first valid image", async () => {
    const first = image("image/png", 10);
    mocks.pick.mockResolvedValue({ images: [first, image("image/png", 20)], error: null });
    expect(await pickAvatarImage()).toEqual({ image: first, problem: null });
    expect(mocks.pick).toHaveBeenCalledWith({ existingCount: 0 });
  });

  it.each([
    ["a wrong type", image("image/gif", 10), "Use a PNG, JPEG or WebP image."],
    ["a big file", image("image/jpeg", 3 * 1024 * 1024), "The image must be under 2 MB."],
  ])("refuses %s with its reason", async (_name, picked, problem) => {
    mocks.pick.mockResolvedValue({ images: [picked], error: null });
    expect(await pickAvatarImage()).toEqual({ image: null, problem });
  });

  it("passes the picker's own error, or nothing when the user cancelled", async () => {
    mocks.pick.mockResolvedValue({ images: [], error: "Photo library unavailable." });
    expect(await pickAvatarImage()).toEqual({ image: null, problem: "Photo library unavailable." });
    mocks.pick.mockResolvedValue({ images: [], error: null });
    expect(await pickAvatarImage()).toEqual({ image: null, problem: null });
  });
});

describe("uploadAvatarImage", () => {
  it("returns the uploaded attachment id", async () => {
    mocks.prepare.mockResolvedValue({ status: "ready", attachments: [{ id: "att-1" }] });
    expect(await uploadAvatarImage("env" as never, image("image/png", 1) as never)).toBe("att-1");
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "env", supportsImageUploads: true }),
    );
  });

  it.each([
    ["an abandoned upload", { status: "abandoned" }],
    ["an inline image without an id", { status: "ready", attachments: [{ type: "image" }] }],
    ["no attachment", { status: "ready", attachments: [] }],
  ])("throws for %s", async (_name, result) => {
    mocks.prepare.mockResolvedValue(result);
    await expect(uploadAvatarImage("env" as never, image("image/png", 1) as never)).rejects.toThrow(
      "The image upload failed.",
    );
  });
});
