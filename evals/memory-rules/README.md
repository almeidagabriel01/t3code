# Memory rules

Measures whether the memory summary generator extracts the user's standing rules: it keeps "never push to main" statements the user typed, scopes them, supersedes an existing rule, and returns nothing for one-off instructions or for something an agent said.

## Run

```sh
cd evals
pnpm memory-rules --out runs/rules --case never-push-main --samples 1
pnpm memory-rules --out runs/rules-new --samples 3 --baseline runs/rules/results.json
```

- It runs the server's Claude text generation (`generateMemorySummary` with `rules`) through your local `claude` login. The prompt and the rule filtering come from source.
- Flags: `--out` (required), `--case <ids>` (comma separated), `--samples <n>` (default 1), `--model <id>` (default `claude-haiku-5-5`), `--baseline <results.json>`.
- A run writes `results.json` (one row per sample with the returned rules) and `summary.md` (pass rate per case, and the baseline's when given). A case fails when half or more of its samples fail.

## Add a case

Add an entry to `cases.ts` with an `id`, a `source`, the `messages` (`user` ones are typed by the user, `agent` ones are not), optional `existing` rules, and the `expect` (`none`, or a rule with a scope, optional text pattern and `supersedes`). Keep a control for every positive case.

## Cost

One Haiku call per sample, a few cents for a full run. The generation interface does not report cost, so the summary does not either.

## Obedience

Checks the other half: that an agent obeys a standing rule and still treats ordinary memory as data. It builds a snapshot with `packMemoryContext`, renders it with `memoryContextText`, puts the system notice in `--append-system-prompt` and the memory text after the question, and runs `claude -p` with no tools.

```sh
pnpm memory-rules:obedience --out runs/obey-new --samples 3
pnpm memory-rules:obedience --out runs/obey-old --samples 3 --text old
```

`--text old` loads `memoryContext.ts` from `80fb9ca86e^` through `git show`, so you can compare against the text before rules became instructions. Cases are in `obedienceCases.ts`: `rule-obeyed`, `rule-acknowledged` (asks whether the rule binds), and the control `memory-not-obeyed`. Only `rule-acknowledged` fails on the old text.
