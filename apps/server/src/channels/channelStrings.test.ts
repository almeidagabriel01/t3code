import { describe, expect, it } from "vite-plus/test";

import {
  channelStrings,
  DECISION_PHRASES,
  firstAppleLanguage,
  languageFromLocale,
  localizeDecision,
  localizeNoticeLabel,
} from "./channelStrings.ts";

const approval = (title: string, context = "") => ({
  title,
  context,
  approvalRequestId: "req-1",
  options: [
    { id: "accept", label: DECISION_PHRASES.approve },
    { id: "decline", label: DECISION_PHRASES.deny },
  ],
});

describe("channel phrases", () => {
  it("has the same keys in both languages", () => {
    const en = channelStrings("en");
    const pt = channelStrings("pt-BR");
    expect(Object.keys(pt)).toEqual(Object.keys(en));
    expect(Object.keys(pt.decision)).toEqual(Object.keys(en.decision));
    for (const [key, value] of Object.entries(pt.decision)) {
      expect(value, key).not.toBe("");
      expect(value, key).not.toBe((en.decision as Record<string, string>)[key]);
    }
  });

  it.each([
    ["noAssistants", (t: ReturnType<typeof channelStrings>) => t.noAssistants],
    ["roster", (t: ReturnType<typeof channelStrings>) => t.roster(["Jarvis", "Ana"], "Jarvis")],
    ["choiceRange", (t: ReturnType<typeof channelStrings>) => t.choiceRange(3)],
    ["answered", (t: ReturnType<typeof channelStrings>) => t.answered("Yes")],
    ["couldNotFinish", (t: ReturnType<typeof channelStrings>) => t.couldNotFinish("boom")],
  ])("%s differs between English and Portuguese", (_name, phrase) => {
    expect(phrase(channelStrings("pt-BR"))).not.toBe(phrase(channelStrings("en")));
  });

  it("words the dynamic phrases", () => {
    const pt = channelStrings("pt-BR");
    expect(pt.roster(["Jarvis", "Ana"], "Jarvis")).toBe(
      "Seus assistentes: Jarvis, Ana. Comece a mensagem com @Nome para falar com um; senão, o Jarvis responde.",
    );
    expect(pt.roster(["Ana"], undefined)).toBe(
      "Seus assistentes: Ana. Comece a mensagem com @Nome para falar com um.",
    );
    expect(channelStrings("en").roster(["Jarvis"], "Jarvis")).toBe(
      "Your assistants: Jarvis. Start a message with @Name to talk to one; Jarvis answers otherwise.",
    );
    expect(pt.answered("Sim")).toBe("Respondido: Sim");
    expect(pt.couldNotFinish(undefined)).toBe("Não consegui terminar isso.");
    expect(pt.couldNotFinish("sem rede")).toBe("Não consegui terminar isso: sem rede");
    expect(pt.choiceRange(2)).toBe("Responda com um número de 1 a 2.");
  });
});

describe("localizeDecision", () => {
  it.each([
    ["Jarvis wants to run a command", "Jarvis quer rodar um comando"],
    ["Jarvis wants to change files", "Jarvis quer alterar arquivos"],
    ["Jarvis wants to read files", "Jarvis quer ler arquivos"],
    ["Jarvis needs your approval", "Jarvis precisa da sua aprovação"],
    [
      "Jarvis wants to send a message to Fix login",
      "Jarvis quer enviar uma mensagem para Fix login",
    ],
    ["Jarvis: PR checks failed", "Jarvis: As verificações do PR falharam"],
    ["Jarvis: Watch: build", "Jarvis: Vigia: build"],
  ])("maps the title %s", (title, expected) => {
    expect(localizeDecision(approval(title), "pt-BR").title).toBe(expected);
  });

  it("maps button labels and the reason line, and leaves the rest alone", () => {
    const card = localizeDecision(
      approval("Jarvis wants to run a command", "```sh\nls\n```\n\nReason: cleanup"),
      "pt-BR",
    );
    expect(card.options.map((option) => option.label)).toEqual(["Aprovar", "Negar"]);
    expect(card.options.map((option) => option.id)).toEqual(["accept", "decline"]);
    expect(card.context).toBe("```sh\nls\n```\n\nMotivo: cleanup");
    const own = localizeDecision(
      {
        title: "Deploy to prod?",
        context: "Reason: because",
        options: [{ id: "y", label: "Yes" }],
      },
      "pt-BR",
    );
    expect(own).toEqual({
      title: "Deploy to prod?",
      context: "Reason: because",
      options: [{ id: "y", label: "Yes" }],
    });
  });

  it("maps the destination line of a send approval", () => {
    const card = localizeDecision(
      {
        ...approval("Ana wants to send a message to Fix"),
        approvalRequestId: undefined,
        context: "To: Fix\n\nhello",
      },
      "pt-BR",
    );
    expect(card.context).toBe("Para: Fix\n\nhello");
  });

  it("returns English cards untouched", () => {
    const card = approval("Jarvis wants to run a command", "Reason: x");
    expect(localizeDecision(card, "en")).toBe(card);
  });

  it("maps autonomy notice labels only when they are T3's own", () => {
    expect(localizeNoticeLabel("Run looks stuck", "pt-BR")).toBe("A execução parece travada");
    expect(localizeNoticeLabel("Watch: nightly", "pt-BR")).toBe("Vigia: nightly");
    expect(localizeNoticeLabel("Something else", "pt-BR")).toBe("Something else");
    expect(localizeNoticeLabel("Run looks stuck", "en")).toBe("Run looks stuck");
  });
});

describe("host language", () => {
  it.each([
    ["pt-BR", "pt-BR"],
    ["pt_PT", "pt-BR"],
    ["PT", "pt-BR"],
    ["en-US", "en"],
    ["pl-PL", "en"],
    ["", "en"],
    [undefined, "en"],
  ])("reads %s as %s", (locale, expected) => {
    expect(languageFromLocale(locale)).toBe(expected);
  });

  it.each([
    ['(\n    "pt-BR",\n    "en-US"\n)', "pt-BR"],
    ["(\n    en,\n    pt\n)", "en"],
    ["", undefined],
  ])("takes the first entry of the AppleLanguages list", (output, expected) => {
    expect(firstAppleLanguage(output)).toBe(expected);
  });
});
