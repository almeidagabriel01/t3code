import { describe, expect, it } from "@effect/vitest";

import { parseLine, withHome } from "./shellLine.ts";

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

  // The one rule for `~`: unquoted at a word's start, and in a `NAME=` word after `=` and each `:`.
  it.each([
    ["~/a", "/h/a"],
    ["~", "/h"],
    ["T=~/a", "T=/h/a"],
    ["PATH=/x:~/a:~", "PATH=/x:/h/a:/h"],
    ["T+=~/a", "T+=/h/a"],
    ["--root=~/a", "--root=~/a"],
    ["a:~/a", "a:~/a"],
    ["a~/a", "a~/a"],
    ["~other/a", "~other/a"],
    ["T=~other:~x", "T=~other:~x"],
    ["'~'/a", "~/a"],
    ["\\~/a", "~/a"],
    ['T="~/a"', "T=~/a"],
    ['T="a:"~/b', "T=a:~/b"],
    ["T=a\\:~/b", "T=a:~/b"],
  ])("expands %s to %s", (source, expanded) => {
    const [word] = parseLine(`echo ${source}`).commands[0]!.words.slice(1);
    expect(withHome(word!, "/h")).toBe(expanded);
  });

  it('names the variables a word expands, with "" for substitutions', () => {
    const [command] = parseLine('vp test $A "${B}" $(c) $((1))').commands.slice(-1);
    expect(command?.words.map((word) => word.vars)).toEqual([[], [], ["A"], ["B"], [""], [""]]);
  });
});
