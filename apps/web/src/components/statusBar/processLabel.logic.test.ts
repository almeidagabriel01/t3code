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
    ["Python", "/Library/Frameworks/Python.framework/Python -m http.server", "http.server"],
    ["python3.12", "python3.12 app.py", "app.py"],
    ["node.exe", "node.exe server.js", "server.js"],
    ["zsh", 'zsh -c "npm run dev"', "npm run dev"],
    ["bash", "bash -l", "bash"],
    ["npx", "npx expo start", "expo start"],
    ["pnpm", "pnpm run dev --silent", "dev"],
    ["vp", "vp run dev", "dev"],
    ["pnpm", "pnpm", "pnpm"],
    ["", "/opt/tool/runner --x", "runner"],
    [
      "Electron Helper",
      "/a/Electron Helper --type=gpu-process --seatbelt-client=35",
      "GPU process",
    ],
    [
      "T3 Code Helper",
      "/a/T3 Code Helper --type=utility --utility-sub-type=network.mojom.NetworkService",
      "Network service",
    ],
    [
      "Electron Helper",
      "/a/Electron Helper --type=utility --utility-sub-type=video_capture.mojom.VideoCaptureService",
      "Video capture service",
    ],
    ["Electron Helper", "/a/Electron Helper --type=utility", "Utility process"],
    ["Electron Helper (Renderer)", "/a/Electron Helper (Renderer) --type=renderer", "Renderer"],
    ["node", "node build.js --type=gpu-process", "build.js"],
    ["", "", ""],
    ["C:\\bin\\node.exe", "x", "node.exe"],
  ])("labels %s %s as %s", (name, command, expected) => {
    expect(processLabel({ name, command })).toBe(expected);
  });
});
