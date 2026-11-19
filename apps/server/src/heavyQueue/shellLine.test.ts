import { describe, expect, it } from "@effect/vitest";

import { parseLine } from "./shellLine.ts";

/** Each command as its word values, in the order the parser finishes them. */
const read = (source: string) => {
  const { commands, unsafe } = parseLine(source);
  return {
    commands: commands.map((command) =>
      [...command.assigns, ...command.words].map((word) => word.value).join(" "),
    ),
    unsafe,
  };
};

describe("parseLine", () => {
  it.each([
    ["echo $((1 + 2)) done", ["echo $((1 + 2)) done"], null],
    ["echo ${HOME}/x ${#list}", ["echo ${HOME}/x ${#list}"], null],
    ["echo $'a\\'b'", ["echo a'b"], null],
    ["echo $? $", ["echo $? $"], null],
    ["echo `vp test run`", ["vp test run", "echo `vp test run`"], null],
    ['echo "a `vp lint` b"', ["vp lint", "echo a `vp lint` b"], null],
    ["`vp test run`", ["vp test run", "`vp test run`"], null],
    ['echo "a\\\nb" c\\\nd', ["echo ab cd"], null],
    ["FILES=(a $(b)) vp test", ["FILES=(a $(b)) vp test"], null],
    ["vp test # cd /elsewhere", ["vp test"], null],
    ["cat <(vp test)", ["vp test", "cat"], "process substitution"],
    ["echo a) b", ["echo a b"], "unbalanced parentheses"],
    ["echo `vp test", ["vp test", "echo `vp test"], "backticks"],
    ["echo ${x", ["echo ${x"], "unbalanced braces"],
    ["echo $'open", ["echo open"], "unbalanced quotes"],
    ["cat <<EOF\nvp test\nEOF\nvp lint", ["cat", "vp lint"], null],
    ["cat <<EOF\nvp test", ["cat"], "unterminated heredoc"],
  ] as const)("%j", (source, commands, unsafe) => {
    expect(read(source)).toEqual({ commands, unsafe });
  });

  it("keeps each for loop's items by its variable, none for a name two loops use", () => {
    const items = (source: string) =>
      [...parseLine(source).loops].map(([name, words]) => [
        name,
        words === null ? null : words.map((word) => word.value),
      ]);
    expect(items("for f in a.ts 'b c.ts'; do vp fmt $f; done")).toEqual([
      ["f", ["a.ts", "b c.ts"]],
    ]);
    expect(items("for f in a; do :; done; for f in b; do :; done")).toEqual([["f", null]]);
    expect(items("for f; do :; done")).toEqual([["f", null]]);
  });

  it('names the variables a word expands, with "" for substitutions', () => {
    const [command] = parseLine('vp test $A "${B}" $(c) $((1))').commands.slice(-1);
    expect(command?.words.map((word) => word.vars)).toEqual([[], [], ["A"], ["B"], [""], [""]]);
  });
});
