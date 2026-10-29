import { expect, it } from "vite-plus/test";

import {
  attachmentImageIds,
  attachmentImageMarkdown,
  parseAttachmentImageSrc,
  replaceAttachmentImageIds,
} from "./attachmentImageRefs.ts";

it("finds, parses, and rewrites image refs", () => {
  const text = `a ${attachmentImageMarkdown("shot [1]", "pending-x")} b ![u](https://e.com/i.png) ${attachmentImageMarkdown("n", "pending-x")}`;
  expect(attachmentImageIds(text)).toEqual(["pending-x"]);
  expect(replaceAttachmentImageIds(text, new Map([["pending-x", "card-y"]]))).toBe(
    "a ![shot  1](t3-attachment:card-y) b ![u](https://e.com/i.png) ![n](t3-attachment:card-y)",
  );
  expect(parseAttachmentImageSrc("t3-attachment:card-y")).toBe("card-y");
  expect(parseAttachmentImageSrc("https://e.com/t3-attachment:x")).toBeNull();
});
