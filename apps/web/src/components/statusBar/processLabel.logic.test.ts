import { describe, expect, it } from "vite-plus/test";

import { processLabel } from "./processLabel.logic";

describe("processLabel", () => {
  it.each([
    ["gradle", "/usr/bin/gradle build", "gradle"],
    ["node", "node /x/node_modules/vite/bin/vite.js --port 1", "vite"],
    ["node", "node /x/node_modules/@scope/pkg/dist/cli.js", "@scope/pkg"],
    ["node", "node --inspect scripts/dev.mjs", "dev.mjs"],
    ["node", "node", "node"],
    ["python3", "python3 scripts/foo.py", "foo.py"],
    ["node", "node -e \"require('x')\"", "node"],
    ["python3", "python3 -c 'print(1)'", "python3"],
    ["python3", "python3 -m http.server 8000", "http.server"],
    ["zsh", 'zsh -c "npm run dev"', "npm run dev"],
    ["bash", "bash -l", "bash"],
    ["npx", "npx expo start", "expo start"],
    ["pnpm", "pnpm run dev --silent", "dev"],
    ["vp", "vp run dev", "dev"],
    ["pnpm", "pnpm", "pnpm"],
    ["", "/opt/tool/runner --x", "runner"],
    ["", "", ""],
    ["C:\\bin\\node.exe", "x", "node.exe"],
  ])("labels %s %s as %s", (name, command, expected) => {
    expect(processLabel({ name, command })).toBe(expected);
  });
});
