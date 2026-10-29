import { expect, it } from "vite-plus/test";

import {
  attachmentImageIds,
  claimedImageIds,
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

const pendingRef = "![shot.png](t3-attachment:pending-11111111-1111-4111-8111-111111111111)";
const claimedRef = "![shot.png](t3-attachment:note-abc-22222222-2222-4222-8222-222222222222)";

it("pairs upload ids with the ids the server stored them under", () => {
  expect(claimedImageIds(`A\n\n${pendingRef}\n`, `A\n\n${claimedRef}\n`)).toEqual(
    new Map([
      [
        "pending-11111111-1111-4111-8111-111111111111",
        "note-abc-22222222-2222-4222-8222-222222222222",
      ],
    ]),
  );
  expect(claimedImageIds(`A\n${pendingRef}`, `B\n${claimedRef}`)).toBe(null);
});
