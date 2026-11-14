import { describe, expect, it } from "vite-plus/test";

import { isContinueRequest, routeGroupMessage } from "./AssistantGroupRouting.ts";

const members = [
  { id: "ada", handle: "ada", name: "Ada" },
  { id: "ana", handle: "ana-p", name: "Ana Paula" },
  { id: "beto", handle: "beto", name: "Beto" },
];
const base = {
  text: "hello",
  members,
  replyOwnerId: null,
  stopped: [],
  fromUser: true,
};

describe("isContinueRequest", () => {
  it.each([
    ["continue", true],
    ["Continua", true],
    ["continua!", true],
    ["  Go on.  ", true],
    ["please continue", true],
    ["por favor, continua", true],
    ["pode continuar", true],
    ["keep going", true],
    ["Prossiga", true],
    ["retomar", true],
    ["continue with the budget", false],
    ["continua no orçamento", false],
    ["don't continue", false],
    ["", false],
    ["discontinue", false],
  ])("%j", (text, expected) => {
    expect(isContinueRequest(text)).toBe(expected);
  });
});

describe("routeGroupMessage", () => {
  const stopped = [
    { taskId: "t2", ownerId: "beto" },
    { taskId: "t1", ownerId: "ada" },
  ];
  it.each([
    [
      "a mention wins over everything",
      { text: "@Ana Paula continue", stopped, requestOwnerId: "ada" },
      { kind: "members", ids: ["ana"] },
    ],
    [
      "thanks with a mention goes to that member",
      { text: "obrigado @ada" },
      { kind: "members", ids: ["ada"] },
    ],
    [
      "a reply goes to its owner",
      { text: "why?", replyOwnerId: "beto", requestOwnerId: "ada" },
      { kind: "members", ids: ["beto"] },
    ],
    [
      "continue resumes the newest stopped task",
      { text: "continue", stopped },
      { kind: "resume", taskId: "t2" },
    ],
    [
      "continue skips a task whose owner left",
      { text: "continua", stopped, members: members.slice(0, 2) },
      { kind: "resume", taskId: "t1" },
    ],
    [
      "continue with nothing stopped follows the request's one member",
      { text: "continue", requestOwnerId: "ada" },
      { kind: "members", ids: ["ada"] },
    ],
    ["continue with nothing stopped in a new request goes to the lead", { text: "continue" }, null],
    [
      "a reply beats continue",
      { text: "continue", stopped, replyOwnerId: "ada" },
      { kind: "members", ids: ["ada"] },
    ],
    [
      "the request's one member takes the follow-up",
      { text: "and Q3?", requestOwnerId: "beto" },
      { kind: "members", ids: ["beto"] },
    ],
    ["its member may have left", { text: "and Q3?", requestOwnerId: "gone" }, null],
    // A message that replies to nothing starts a request, whatever else is open.
    ["a new request goes to the lead", { text: "and Q3?" }, null],
    [
      "a group of one takes anything",
      { text: "and Q3?", members: [members[0]!] },
      { kind: "members", ids: ["ada"] },
    ],
    ["an agent never resumes", { text: "continue", stopped, fromUser: false }, null],
    [
      "an agent never follows up",
      { text: "any news?", requestOwnerId: "ada", fromUser: false },
      null,
    ],
    [
      "an agent can still name a member",
      { text: "@beto look", fromUser: false },
      { kind: "members", ids: ["beto"] },
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(routeGroupMessage({ ...base, ...input } as never)).toEqual(expected);
  });
});
