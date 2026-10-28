import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attributeToProject,
  decideKill,
  parseParentTable,
  protectedPids,
  parseLsofCwds,
  parseLsofListeners,
  parseNetstatListeners,
  parseProcNetTcp,
} from "./ListeningPorts.ts";

describe("parseLsofListeners", () => {
  it("keeps bind addresses and collapses duplicate sockets of one process", () => {
    const raw = [
      "p101",
      "cnode",
      "n127.0.0.1:3000",
      "n[::1]:3000",
      "n*:5173",
      "n*:5173",
      "p202",
      "cpostgres",
      "n*:5432 (LISTEN)",
      "",
    ].join("\n");
    expect(parseLsofListeners(raw)).toEqual([
      { port: 3000, host: "127.0.0.1", pid: 101, processName: "node" },
      { port: 3000, host: "::1", pid: 101, processName: "node" },
      { port: 5173, host: "*", pid: 101, processName: "node" },
      { port: 5432, host: "*", pid: 202, processName: "postgres" },
    ]);
  });

  it("reads working directories per pid", () => {
    const raw = "p101\nfcwd\nn/work/app\np202\nfcwd\nn/\n";
    expect(parseLsofCwds(raw)).toEqual(
      new Map([
        [101, "/work/app"],
        [202, "/"],
      ]),
    );
  });
});

describe("parseProcNetTcp", () => {
  it("decodes listeners and skips other socket states", () => {
    const raw = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1",
      "   1: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1",
      "   2: 0100007F:0BB9 0100007F:9999 01 00000000:00000000 00:00000000 00000000  1000        0 33333 1",
      "   3: 0100007F:0BBA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1",
      "",
    ].join("\n");
    expect(parseProcNetTcp(raw)).toEqual([
      { host: "127.0.0.1", port: 3000, inode: "11111" },
      { host: "0.0.0.0", port: 5432, inode: "22222" },
    ]);
  });

  it("decodes IPv6 loopback, wildcard and mapped addresses", () => {
    const row = (address: string, inode: string) =>
      `   0: ${address}:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1`;
    const raw = [
      "header",
      row("00000000000000000000000001000000", "1"),
      row("00000000000000000000000000000000", "2"),
      row("0000000000000000FFFF00000100007F", "3"),
    ].join("\n");
    expect(parseProcNetTcp(raw).map((l) => l.host)).toEqual(["::1", "::", "127.0.0.1"]);
  });
});

describe("parseNetstatListeners", () => {
  it("returns listening rows only", () => {
    const raw = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1048",
      "  TCP    127.0.0.1:3000         127.0.0.1:50000        ESTABLISHED     2000",
      "  TCP    [::1]:8080             [::]:0                 LISTENING       3000",
    ].join("\r\n");
    expect(parseNetstatListeners(raw)).toEqual([
      { port: 135, host: "0.0.0.0", pid: 1048, processName: null },
      { port: 8080, host: "::1", pid: 3000, processName: null },
    ]);
  });
});

describe("attributeToProject", () => {
  const roots = [
    { projectId: ProjectId.make("outer"), workspaceRoot: "/work/app" },
    { projectId: ProjectId.make("inner"), workspaceRoot: "/work/app/packages/web/" },
    { projectId: ProjectId.make("sibling"), workspaceRoot: "/work/app-two" },
  ];

  it("picks the deepest containing root", () => {
    expect(attributeToProject("/work/app/packages/web/src", roots)).toBe("inner");
    expect(attributeToProject("/work/app/packages/web", roots)).toBe("inner");
    expect(attributeToProject("/work/app/other", roots)).toBe("outer");
  });

  it("does not match on a shared name prefix or without a cwd", () => {
    expect(attributeToProject("/work/application", roots)).toBeNull();
    expect(attributeToProject("/work/app-two/x", roots)).toBe("sibling");
    expect(attributeToProject(null, roots)).toBeNull();
  });
});

describe("decideKill", () => {
  const listeners = [
    { port: 3000, host: "127.0.0.1", pid: 500, processName: "node" },
    { port: 4000, host: "*", pid: 600, processName: "Electron" },
    { port: 5000, host: "*", pid: 700, processName: "node" },
  ];
  const guarded = new Set([700, 10]);

  it("allows a pid that holds the port", () => {
    expect(decideKill({ listeners, pid: 500, port: 3000, protectedPids: guarded })).toBe("allowed");
  });

  it("refuses a pid that does not hold that port", () => {
    expect(decideKill({ listeners, pid: 500, port: 4000, protectedPids: guarded })).toBe(
      "not-found",
    );
    expect(decideKill({ listeners, pid: 999, port: 3000, protectedPids: guarded })).toBe(
      "not-found",
    );
  });

  it("refuses this server, its ancestors and desktop processes", () => {
    expect(decideKill({ listeners, pid: 700, port: 5000, protectedPids: guarded })).toBe(
      "protected",
    );
    expect(decideKill({ listeners, pid: 600, port: 4000, protectedPids: guarded })).toBe(
      "protected",
    );
  });

  it("guards the server and every ancestor from the process table", () => {
    const parents = parseParentTable("  1     0\n 10     1\n 20    10\n 30    20\n 40    10\n");
    const pids = protectedPids(parents, 30);
    expect([...pids].toSorted((a, b) => a - b)).toEqual(expect.arrayContaining([10, 20, 30]));
    expect(pids.has(40)).toBe(false);
  });
});
