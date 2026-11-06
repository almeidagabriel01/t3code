/**
 * T3's own fixed phrases in the chats it talks through, in each language it speaks. Assistant-written
 * text is never run through here. Decisions stay English in storage (the app shows them as written);
 * `localizeDecision` maps their known phrases when a card is rendered into a chat.
 */
import type { ChannelLanguage } from "@t3tools/contracts";

export type ResolvedChannelLanguage = Exclude<ChannelLanguage, "auto">;

export interface ChannelStrings {
  readonly noAssistants: string;
  /** `defaultName` is the assistant that answers when a message names nobody. */
  readonly roster: (names: ReadonlyArray<string>, defaultName: string | undefined) => string;
  readonly switched: (name: string) => string;
  readonly choiceRange: (count: number) => string;
  readonly alreadyAnswered: string;
  readonly couldNotRecord: string;
  readonly couldNotReach: string;
  readonly couldNotPassOn: (reason: string) => string;
  readonly conversationNotStarted: string;
  readonly rateLimited: string;
  readonly replyWithNumber: string;
  readonly truncatedNote: string;
  readonly approvalNotice: string;
  readonly couldNotFinish: (detail: string | undefined) => string;
  readonly withdrawn: string;
  readonly expired: string;
  readonly approved: string;
  readonly denied: string;
  readonly dismissed: string;
  readonly answered: (chosen: string) => string;
  readonly decision: {
    readonly approve: string;
    readonly deny: string;
    readonly gotIt: string;
    readonly reason: string;
    readonly to: string;
    /** What follows an assistant's name in an approval title. */
    readonly wantsCommand: string;
    readonly wantsFileChange: string;
    readonly wantsFileRead: string;
    readonly needsApproval: string;
    readonly wantsToSend: string;
    /** What follows `<name>: ` in an autonomy notice title. */
    readonly runFailed: string;
    readonly waitingTooLong: string;
    readonly stuck: string;
    readonly ciFailed: string;
    readonly reviewIncomplete: string;
    readonly watch: string;
  };
}

const en: ChannelStrings = {
  noAssistants: "No assistants are set up. Create one in Settings → Assistants.",
  roster: (names, defaultName) =>
    `Your assistants: ${names.join(", ")}. Start a message with @Name to talk to one${defaultName === undefined ? "" : `; ${defaultName} answers otherwise`}.`,
  switched: (name) => `You are now talking to ${name}.`,
  choiceRange: (count) => `Reply with a number from 1 to ${count}.`,
  alreadyAnswered: "That decision was already answered.",
  couldNotRecord: "I could not record that answer. Please try again.",
  couldNotReach: "I could not reach your assistants right now. Please try again.",
  couldNotPassOn: (reason) => `I could not pass that on: ${reason}`,
  conversationNotStarted: "its conversation has not started yet",
  rateLimited: "You're sending messages too fast. I'll read new ones again in a minute.",
  replyWithNumber: "Reply with the number.",
  truncatedNote: "… The rest of this reply was too long to send.",
  approvalNotice:
    "Your message is waiting for the owner's approval in T3 Code. You can chat here once they allow you.",
  couldNotFinish: (detail) =>
    `I could not finish that${detail === undefined ? "." : `: ${detail}`}`,
  withdrawn: "Withdrawn",
  expired: "Expired",
  approved: "Approved",
  denied: "Denied",
  dismissed: "Dismissed",
  answered: (chosen) => `Answered: ${chosen}`,
  decision: {
    approve: "Approve",
    deny: "Deny",
    gotIt: "Got it",
    reason: "Reason:",
    to: "To:",
    wantsCommand: "wants to run a command",
    wantsFileChange: "wants to change files",
    wantsFileRead: "wants to read files",
    needsApproval: "needs your approval",
    wantsToSend: "wants to send a message to",
    runFailed: "Run failed or was interrupted",
    waitingTooLong: "Waiting for you too long",
    stuck: "Run looks stuck",
    ciFailed: "PR checks failed",
    reviewIncomplete: "Card in Review with open items",
    watch: "Watch:",
  },
};

const ptBR: ChannelStrings = {
  noAssistants: "Nenhum assistente configurado. Crie um em Configurações → Assistentes.",
  roster: (names, defaultName) =>
    `Seus assistentes: ${names.join(", ")}. Comece a mensagem com @Nome para falar com um${defaultName === undefined ? "" : `; senão, ${defaultName === "Jarvis" ? "o " : ""}${defaultName} responde`}.`,
  switched: (name) => `Agora você está falando com ${name}.`,
  choiceRange: (count) => `Responda com um número de 1 a ${count}.`,
  alreadyAnswered: "Essa decisão já foi respondida.",
  couldNotRecord: "Não consegui registrar essa resposta. Tente de novo.",
  couldNotReach: "Não consegui falar com seus assistentes agora. Tente de novo.",
  couldNotPassOn: (reason) => `Não consegui repassar isso: ${reason}`,
  conversationNotStarted: "a conversa dele ainda não começou",
  rateLimited: "Você está mandando mensagens rápido demais. Volto a ler as novas em um minuto.",
  replyWithNumber: "Responda com o número.",
  truncatedNote: "… O resto desta resposta era longo demais para enviar.",
  approvalNotice:
    "Sua mensagem está aguardando a aprovação do dono no T3 Code. Você poderá conversar aqui assim que ele liberar.",
  couldNotFinish: (detail) =>
    `Não consegui terminar isso${detail === undefined ? "." : `: ${detail}`}`,
  withdrawn: "Retirado",
  expired: "Expirado",
  approved: "Aprovado",
  denied: "Negado",
  dismissed: "Dispensado",
  answered: (chosen) => `Respondido: ${chosen}`,
  decision: {
    approve: "Aprovar",
    deny: "Negar",
    gotIt: "Entendi",
    reason: "Motivo:",
    to: "Para:",
    wantsCommand: "quer rodar um comando",
    wantsFileChange: "quer alterar arquivos",
    wantsFileRead: "quer ler arquivos",
    needsApproval: "precisa da sua aprovação",
    wantsToSend: "quer enviar uma mensagem para",
    runFailed: "A execução falhou ou foi interrompida",
    waitingTooLong: "Esperando por você há muito tempo",
    stuck: "A execução parece travada",
    ciFailed: "As verificações do PR falharam",
    reviewIncomplete: "Card em Revisão com itens em aberto",
    watch: "Vigia:",
  },
};

const TABLES: Readonly<Record<ResolvedChannelLanguage, ChannelStrings>> = { en, "pt-BR": ptBR };

export const channelStrings = (language: ResolvedChannelLanguage): ChannelStrings =>
  TABLES[language];

/** The English phrases decisions are created with, so the creators and the channel mapping cannot drift. */
export const DECISION_PHRASES = en.decision;

/** "pt", "pt-BR" and "pt_PT" speak Portuguese; anything else, or nothing, reads English. */
export const languageFromLocale = (locale: string | undefined): ResolvedChannelLanguage =>
  /^pt(?:[-_]|$)/i.test(locale?.trim() ?? "") ? "pt-BR" : "en";

/** First entry of `defaults read -g AppleLanguages`, a plist-style list such as `("pt-BR", "en-US")`. */
export const firstAppleLanguage = (output: string): string | undefined =>
  /\(\s*"?([^",\s)]+)/.exec(output)?.[1];

interface CardLike {
  readonly title: string;
  readonly context: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly approvalRequestId?: string | undefined;
}

type DecisionKey = keyof ChannelStrings["decision"];
const AFTER_NAME: ReadonlyArray<DecisionKey> = [
  "wantsCommand",
  "wantsFileChange",
  "wantsFileRead",
  "needsApproval",
  "wantsToSend",
];
const AFTER_COLON: ReadonlyArray<DecisionKey> = [
  "runFailed",
  "waitingTooLong",
  "stuck",
  "ciFailed",
  "reviewIncomplete",
  "watch",
];
const LABELS: ReadonlyArray<DecisionKey> = ["approve", "deny", "gotIt"];

/**
 * A decision's known T3 phrases in `language`. Everything an assistant wrote (names, command text,
 * question text, other option labels) passes through untouched.
 */
export function localizeDecision<A extends CardLike>(
  card: A,
  language: ResolvedChannelLanguage,
): A {
  if (language === "en") return card;
  const from = en.decision;
  const to = ptBR.decision;
  let title = card.title;
  let sendsMessage = false;
  for (const key of AFTER_NAME) {
    if (title.includes(` ${from[key]}`)) {
      title = title.replace(` ${from[key]}`, ` ${to[key]}`);
      sendsMessage ||= key === "wantsToSend";
      break;
    }
  }
  for (const key of AFTER_COLON) {
    if (title.includes(`: ${from[key]}`)) {
      title = title.replace(`: ${from[key]}`, `: ${to[key]}`);
      break;
    }
  }
  let context = card.context;
  if (card.approvalRequestId !== undefined) {
    context = context.replace(/(^|\n\n)Reason: /g, `$1${to.reason} `);
  }
  if (sendsMessage && context.startsWith(`${from.to} `)) {
    context = `${to.to} ${context.slice(from.to.length + 1)}`;
  }
  const labels = new Map(LABELS.map((key) => [from[key], to[key]]));
  return {
    ...card,
    title,
    context,
    options: card.options.map((option) => ({
      ...option,
      label: labels.get(option.label) ?? option.label,
    })),
  };
}

/** A fixed English label such as an autonomy rule's, in `language`; anything else is returned as is. */
export function localizeNoticeLabel(label: string, language: ResolvedChannelLanguage): string {
  if (language === "en") return label;
  for (const key of AFTER_COLON) {
    if (key !== "watch" && label === en.decision[key]) return ptBR.decision[key];
  }
  return label.startsWith(`${en.decision.watch} `)
    ? `${ptBR.decision.watch} ${label.slice(en.decision.watch.length + 1)}`
    : label;
}
