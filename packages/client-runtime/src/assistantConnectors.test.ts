import { assert, it } from "@effect/vitest";
import type { AssistantMcpServer } from "@t3tools/contracts";

import {
  connectorDraftsFrom,
  connectorDraftsProblem,
  connectorInputsFrom,
  connectorsEqual,
  emptyConnectorDraft,
} from "./assistantConnectors.ts";

const docs: AssistantMcpServer = {
  name: "docs",
  transport: "http",
  url: "https://docs.example.test/mcp",
  args: [],
  headers: [
    { key: "Authorization", hasValue: true },
    { key: "X-Empty", hasValue: false },
  ],
  env: [],
  enabled: true,
};
const files: AssistantMcpServer = {
  name: "files",
  transport: "stdio",
  command: "npx",
  args: ["-y", "srv"],
  headers: [],
  env: [{ key: "TOKEN", hasValue: true }],
  enabled: false,
};

it("drafts round-trip, and an untouched saved row sends no value so the secret is kept", () => {
  const drafts = connectorDraftsFrom([docs, files]);
  assert.equal(drafts[1]!.args, "-y\nsrv");
  assert.deepEqual(connectorInputsFrom(drafts), [
    {
      name: "docs",
      transport: "http",
      url: "https://docs.example.test/mcp",
      headers: [{ key: "Authorization" }, { key: "X-Empty" }],
      enabled: true,
    },
    {
      name: "files",
      transport: "stdio",
      command: "npx",
      args: ["-y", "srv"],
      env: [{ key: "TOKEN" }],
      enabled: false,
    },
  ]);
});

it("typed values are sent, blank keys and blank args are dropped", () => {
  const draft = {
    ...emptyConnectorDraft(),
    name: " web ",
    url: " https://x.test ",
    headers: [
      { id: "a", key: " A ", value: "v", saved: false },
      { id: "b", key: " ", value: "ignored", saved: false },
    ],
  };
  assert.deepEqual(connectorInputsFrom([draft]), [
    {
      name: "web",
      transport: "http",
      url: "https://x.test",
      headers: [{ key: "A", value: "v" }],
      enabled: true,
    },
  ]);
  assert.deepEqual(
    connectorInputsFrom([{ ...draft, transport: "stdio", command: "x", args: "a\n\n b \n" }])[0],
    { name: "web", transport: "stdio", command: "x", args: ["a", "b"], env: [], enabled: true },
  );
});

it("reports the first unusable draft and compares by value", () => {
  const [a] = connectorDraftsFrom([docs]);
  assert.isNull(connectorDraftsProblem([a!]));
  assert.match(connectorDraftsProblem([{ ...a!, name: "Bad Name" }]) ?? "", /Name each connector/);
  assert.match(connectorDraftsProblem([{ ...a!, url: "nope" }]) ?? "", /http or https URL/);
  assert.match(connectorDraftsProblem([a!, a!]) ?? "", /Two connectors/);
  assert.isTrue(connectorsEqual([a!], [{ ...a! }]));
  assert.isFalse(connectorsEqual([a!], [{ ...a!, enabled: false }]));
});
