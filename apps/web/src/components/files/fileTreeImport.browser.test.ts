import { describe, expect, it } from "vite-plus/test";

import {
  collectDroppedFiles,
  dropTargetDirectory,
  isExternalFileDrag,
  isOverTreeRow,
} from "./fileTreeImport";

const row = (path: string, type: "file" | "folder") => {
  const element = document.createElement("div");
  element.setAttribute("data-item-path", path);
  element.setAttribute("data-item-type", type);
  return element;
};

const fileEntry = (name: string, contents: string) => ({
  name,
  isFile: true,
  isDirectory: false,
  file: (resolve: (file: File) => void) => resolve(new File([contents], name)),
});

const directoryEntry = (name: string, children: readonly object[]) => ({
  name,
  isFile: false,
  isDirectory: true,
  createReader: () => {
    // Browsers hand directory children over in batches and end with an empty one.
    const batches = [children.slice(0, 1), children.slice(1), []];
    return {
      readEntries: (resolve: (batch: readonly object[]) => void) => resolve(batches.shift()!),
    };
  },
});

describe("fileTreeImport", () => {
  it("picks the folder under the pointer, a file's folder, or the root", () => {
    const span = document.createElement("span");
    expect(dropTargetDirectory([span, row("src/", "folder")])).toBe("src");
    expect(dropTargetDirectory([row("src/a/b.ts", "file")])).toBe("src/a");
    expect(dropTargetDirectory([row("README.md", "file")])).toBe("");
    expect(dropTargetDirectory([span, window])).toBe("");
    expect(isOverTreeRow([span, row("a", "file")])).toBe(true);
    expect(isOverTreeRow([span])).toBe(false);
  });

  it("recognizes drags that carry files", () => {
    const files = new DataTransfer();
    files.items.add(new File(["x"], "x.txt"));
    const text = new DataTransfer();
    text.setData("text/plain", "x");
    expect(isExternalFileDrag(files)).toBe(true);
    expect(isExternalFileDrag(text)).toBe(false);
    expect(isExternalFileDrag(null)).toBe(false);
  });

  it("walks dropped folders and falls back to plain files", async () => {
    const plain = new File(["p"], "plain.txt");
    const dataTransfer = {
      items: [
        {
          kind: "file",
          webkitGetAsEntry: () =>
            directoryEntry("assets", [
              fileEntry("a.png", "a"),
              directoryEntry("icons", [fileEntry("b.svg", "b")]),
            ]),
          getAsFile: () => null,
        },
        { kind: "file", webkitGetAsEntry: () => null, getAsFile: () => plain },
        { kind: "string", webkitGetAsEntry: () => null, getAsFile: () => null },
      ],
    } as unknown as DataTransfer;
    const files = await collectDroppedFiles(dataTransfer);
    expect(files.map((file) => file.relativePath)).toEqual([
      "assets/a.png",
      "assets/icons/b.svg",
      "plain.txt",
    ]);
    expect(await files[1]!.file.text()).toBe("b");
  });
});
