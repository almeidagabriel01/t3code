/**
 * A shell line split the way `sh` reads it: simple commands with their words, assignments and
 * redirects, and the operators between them. Tolerant on purpose: anything it cannot follow
 * (a heredoc, `eval`, unbalanced quotes) sets `unsafe` and parsing carries on, so a cut-off
 * label still names its commands while the Runner keeps such a line on this Mac.
 */

export interface Word {
  /** Source span, so a line is rewritten by splicing, never re-serialized. */
  readonly start: number;
  readonly end: number;
  /** Quotes removed and escapes applied; expansions stay as written (`$L`). */
  readonly value: string;
  /** Variables it expands by name; "" for a command substitution or arithmetic. */
  readonly vars: ReadonlyArray<string>;
  /** Starts with an unquoted `~`. */
  readonly tilde: boolean;
}

export interface Redirect {
  readonly op: string;
  readonly target: Word | null;
}

export interface Command {
  readonly start: number;
  readonly end: number;
  /** Leading `NAME=value` words. */
  readonly assigns: ReadonlyArray<Word>;
  readonly words: ReadonlyArray<Word>;
  readonly redirects: ReadonlyArray<Redirect>;
  /** The operator after it (`&&`, `||`, `;`, `|`, `|&`, `&`), or null where its list ends. */
  readonly next: string | null;
  /** Reads the previous command's output through a pipe. */
  readonly piped: boolean;
  /** Enclosing `( … )` subshells by id, outermost first: a `cd` inside ends with them. */
  readonly scope: ReadonlyArray<number>;
  /** Inside `$( … )`, backticks or a process substitution. */
  readonly substituted: boolean;
  /** Inside `if`, `while`, `until` or `for`: it may run any number of times. */
  readonly conditional: boolean;
}

export interface ParsedLine {
  /** In the order they finish, so a substitution's commands come before the one using it. */
  readonly commands: ReadonlyArray<Command>;
  /** Why the line cannot be followed exactly, or null. */
  readonly unsafe: string | null;
  /** `for x in a b`: each loop variable's items; null for a name two loops use. */
  readonly loops: ReadonlyMap<string, ReadonlyArray<Word> | null>;
}

const META = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);
const REDIRECT = /^(\d*)(&>>|&>|>>|>&|>\||<<<|<<-|<<|<&|<>|>|<)/;
const ASSIGN = /^[A-Za-z_]\w*\+?=/;
const OPENS = new Set(["if", "while", "until", "for", "select"]);
const CLOSES = new Set(["fi", "done"]);
const SKIPPED = new Set(["then", "else", "elif", "do", "!", "{", "}"]);
const UNREADABLE = new Set(["case", "function", "eval", "coproc"]);

interface Context {
  readonly scope: ReadonlyArray<number>;
  readonly substituted: boolean;
  conditional: number;
  readonly until: ")" | "`" | null;
}

export const parseLine = (source: string): ParsedLine => {
  const commands: Command[] = [];
  let unsafe: string | null = null;
  const loops = new Map<string, ReadonlyArray<Word> | null>();
  const flag = (why: string) => {
    unsafe ??= why;
  };
  let at = 0;
  let scopes = 0;
  const heredocs: Array<{ readonly delimiter: string; readonly strip: boolean }> = [];

  /** A heredoc's body is text a program reads, never commands. */
  const skipHeredocBodies = () => {
    for (const { delimiter, strip } of heredocs.splice(0)) {
      let found = false;
      while (!found && at < source.length) {
        const newline = source.indexOf("\n", at);
        const text = source.slice(at, newline < 0 ? source.length : newline);
        at = newline < 0 ? source.length : newline + 1;
        found = (strip ? text.replace(/^\t+/, "") : text) === delimiter;
      }
      if (!found) flag("unterminated heredoc");
    }
  };

  const nested = (context: Context, until: ")" | "`", scope = context.scope) =>
    parseList({ scope, substituted: until === "`" || context.substituted, conditional: 0, until });

  /** At `$`: consumes one expansion and returns its text as written. */
  const readDollar = (context: Context, vars: string[]): string => {
    const start = at;
    const next = source[at + 1];
    if (next === "(" && source[at + 2] === "(") {
      let depth = 0;
      for (at += 1; at < source.length; at++) {
        if (source[at] === "(") depth++;
        else if (source[at] === ")" && --depth === 0) break;
      }
      at = Math.min(source.length, at + 1);
      vars.push("");
      return source.slice(start, at);
    }
    if (next === "(") {
      at += 2;
      parseList({
        scope: context.scope,
        substituted: true,
        conditional: 0,
        until: ")",
      });
      vars.push("");
      return source.slice(start, at);
    }
    if (next === "{") {
      const close = source.indexOf("}", at);
      at = close < 0 ? source.length : close + 1;
      if (close < 0) flag("unbalanced braces");
      const name = /^\$\{[#!]?([A-Za-z_]\w*|[0-9@*#?$!-])/.exec(source.slice(start, at))?.[1];
      vars.push(name ?? "");
      return source.slice(start, at);
    }
    if (next === "'") {
      at += 2;
      let text = "";
      while (at < source.length && source[at] !== "'") {
        text += source[at] === "\\" ? (source[++at] ?? "") : source[at];
        at++;
      }
      if (at >= source.length) flag("unbalanced quotes");
      at++;
      return text;
    }
    const name = /^\$([A-Za-z_]\w*|[0-9@*#?$!-])/.exec(source.slice(at, at + 64))?.[1];
    if (name === undefined) {
      at++;
      return "$";
    }
    at += 1 + name.length;
    vars.push(name);
    return source.slice(start, at);
  };

  const readBackticks = (context: Context, vars: string[]) => {
    const start = at;
    at++;
    nested(context, "`");
    vars.push("");
    return source.slice(start, at);
  };

  const readWord = (context: Context): Word => {
    const start = at;
    const tilde = source[at] === "~";
    const vars: string[] = [];
    let value = "";
    while (at < source.length) {
      const c = source[at]!;
      if (META.has(c)) break;
      if (c === "`") {
        if (context.until === "`") break;
        value += readBackticks(context, vars);
      } else if (c === "\\") {
        if (source[at + 1] !== "\n") value += source[at + 1] ?? "";
        at += 2;
      } else if (c === "'") {
        const close = source.indexOf("'", at + 1);
        if (close < 0) {
          flag("unbalanced quotes");
          value += source.slice(at + 1);
          at = source.length;
        } else {
          value += source.slice(at + 1, close);
          at = close + 1;
        }
      } else if (c === '"') {
        at++;
        while (at < source.length && source[at] !== '"') {
          const d = source[at]!;
          if (d === "\\" && /[$`"\\\n]/.test(source[at + 1] ?? "")) {
            if (source[at + 1] !== "\n") value += source[at + 1];
            at += 2;
          } else if (d === "$") value += readDollar(context, vars);
          else if (d === "`") value += readBackticks(context, vars);
          else {
            value += d;
            at++;
          }
        }
        if (at >= source.length) flag("unbalanced quotes");
        at++;
      } else if (c === "$") {
        value += readDollar(context, vars);
      } else if (
        c === "=" &&
        source[at + 1] === "(" &&
        /^[A-Za-z_]\w*\+?$/.test(source.slice(start, at))
      ) {
        // `FILES=(a $(b))`: an array, read as a value only this shell knows.
        at += 2;
        const before = commands.length;
        nested(context, ")");
        commands.length = before;
        vars.push("");
        value += source.slice(start + value.length, at);
      } else {
        value += c;
        at++;
      }
    }
    return { start, end: Math.min(at, source.length), value, vars, tilde };
  };

  const parseList = (context: Context): void => {
    let start = -1;
    let end = -1;
    let assigns: Word[] = [];
    let words: Word[] = [];
    let redirects: Redirect[] = [];
    let piped = false;
    /** `for x in a b`: words that are not a command. */
    let header = false;
    let headerWords: Word[] = [];
    const mark = (from: number) => {
      if (start < 0) start = from;
      end = at;
    };
    const finish = (next: string | null) => {
      if (!header && start >= 0) {
        commands.push({
          start,
          end,
          assigns,
          words,
          redirects,
          next,
          piped,
          scope: context.scope,
          substituted: context.substituted,
          conditional: context.conditional > 0,
        });
      }
      piped = next === "|" || next === "|&";
      const [name, keyword, ...items] = headerWords;
      if (header && name !== undefined) {
        loops.set(name.value, loops.has(name.value) || keyword?.value !== "in" ? null : items);
      }
      header = false;
      headerWords = [];
      start = -1;
      assigns = [];
      words = [];
      redirects = [];
    };

    while (at < source.length) {
      const c = source[at]!;
      const two = source.slice(at, at + 2);
      if (c === " " || c === "\t") at++;
      else if (two === "\\\n") at += 2;
      else if (c === "#") {
        const newline = source.indexOf("\n", at);
        at = newline < 0 ? source.length : newline;
      } else if (c === "\n") {
        at++;
        finish(";");
        skipHeredocBodies();
      } else if (c === ")" && context.until === ")") {
        at++;
        finish(null);
        return;
      } else if (c === "`" && context.until === "`") {
        at++;
        finish(null);
        return;
      } else if (c === ")") {
        flag("unbalanced parentheses");
        at++;
      } else if (two === "&&" || two === "||" || two === "|&" || two === ";;") {
        if (two === ";;") flag("case");
        at += 2;
        finish(two);
      } else if (c === ";" || c === "|" || (c === "&" && source[at + 1] !== ">")) {
        at++;
        finish(c);
      } else if ((c === "<" || c === ">") && source[at + 1] === "(") {
        flag("process substitution");
        const from = at;
        at += 2;
        nested(context, ")");
        mark(from);
      } else if (REDIRECT.test(source.slice(at, at + 8))) {
        const from = at;
        const [text, fd, op] = REDIRECT.exec(source.slice(at, at + 8))!;
        at += text.length;
        while (source[at] === " " || source[at] === "\t") at++;
        const target = at < source.length && !META.has(source[at]!) ? readWord(context) : null;
        if (op === "<<" || op === "<<-") {
          if (target === null) flag("heredoc");
          else heredocs.push({ delimiter: target.value, strip: op === "<<-" });
        }
        redirects.push({ op: `${fd}${op}`, target });
        mark(from);
      } else if (c === "(") {
        if (words.length > 0 || assigns.length > 0) flag("function or array");
        at++;
        parseList({
          scope: [...context.scope, scopes++],
          substituted: context.substituted,
          conditional: context.conditional,
          until: ")",
        });
      } else {
        const word = readWord(context);
        const keyword = words.length === 0 && assigns.length === 0 && !header;
        const plain = source.slice(word.start, word.end);
        if (keyword && OPENS.has(plain)) {
          context.conditional++;
          header = plain === "for" || plain === "select";
        } else if (keyword && CLOSES.has(plain)) {
          context.conditional = Math.max(0, context.conditional - 1);
        } else if (keyword && SKIPPED.has(plain)) {
          // A keyword: the next word starts the command.
        } else if (header) {
          // `for x in a b c`
          headerWords.push(word);
        } else if (words.length === 0 && ASSIGN.test(plain)) {
          assigns.push(word);
          mark(word.start);
        } else {
          if (keyword && UNREADABLE.has(plain)) flag(plain);
          words.push(word);
          mark(word.start);
        }
      }
    }
    if (context.until !== null)
      flag(context.until === ")" ? "unbalanced parentheses" : "backticks");
    finish(null);
    if (heredocs.length > 0) flag("unterminated heredoc");
  };

  parseList({ scope: [], substituted: false, conditional: 0, until: null });
  return { commands, unsafe, loops };
};
