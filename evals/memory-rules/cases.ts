import type { Expectation } from "./grade.ts";

export type MemoryRuleCase = {
  readonly id: string;
  readonly source: string;
  /** Messages in order; `user` ones are typed by the user, the rest come from the agent. */
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: "user" | "agent";
    readonly text: string;
  }>;
  readonly existing?: ReadonlyArray<{
    readonly memoryId: string;
    readonly scope: "project" | "user";
    readonly text: string;
  }>;
  readonly expect: Expectation;
};

const source = "Gabriel request 2026-11-06, thread on continuous memory";
const work = [
  { id: "a1", role: "agent", text: "I read apps/web/src/Button.tsx and found the handler." },
  { id: "a2", role: "agent", text: "Updated the handler and ran the tests; all pass." },
] as const;

export const memoryRuleCases: ReadonlyArray<MemoryRuleCase> = [
  {
    id: "never-push-main",
    source,
    messages: [
      {
        id: "u1",
        role: "user",
        text: "Nunca faça push direto na main neste projeto, sempre abra PR.",
      },
      ...work,
    ],
    expect: { kind: "rule", scope: "project", text: /main|PR|pull request/i },
  },
  {
    id: "global-language",
    source,
    messages: [
      { id: "u1", role: "user", text: "Em qualquer projeto, sempre me responda em português." },
      ...work,
    ],
    expect: { kind: "rule", scope: "user" },
  },
  {
    id: "one-off-control",
    source,
    messages: [{ id: "u1", role: "user", text: "Corrige o bug do botão de salvar." }, ...work],
    expect: { kind: "none" },
  },
  {
    id: "agent-said-never",
    source,
    messages: [
      { id: "u1", role: "user", text: "Corrige o bug do botão de salvar." },
      {
        id: "a1",
        role: "agent",
        text: "Entendido. Nunca vou fazer push direto na main em acme/app.",
      },
      work[1],
    ],
    expect: { kind: "none" },
  },
  {
    id: "supersede",
    source,
    existing: [{ memoryId: "m-npm", scope: "project", text: "Use npm for installs." }],
    messages: [
      { id: "u1", role: "user", text: "A partir de agora use pnpm, não npm, neste projeto." },
      ...work,
    ],
    expect: { kind: "rule", scope: "project", text: /pnpm/i, supersedes: "m-npm" },
  },
  {
    id: "task-instruction-control",
    source,
    messages: [
      { id: "u1", role: "user", text: "Não mexe no arquivo README nesta tarefa." },
      ...work,
    ],
    expect: { kind: "none" },
  },
];
