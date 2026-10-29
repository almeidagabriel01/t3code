import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor, supportsMemoryProtocol } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("keeps memory browsing extensions optional for older environments", () => {
    for (const value of [undefined, false, true]) {
      const memory = decodeDescriptor({
        ...descriptor,
        capabilities: {
          memory: {
            protocolVersion: 1,
            ...(value === undefined ? {} : { resolutionInputs: value, retainedLocalSpace: value }),
          },
        },
      }).capabilities.memory!;
      expect(memory.resolutionInputs).toBe(value);
      expect(memory.retainedLocalSpace).toBe(value);
    }
  });
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
});

describe("memory advertisement", () => {
  it("decodes descriptor without memory advertisement", () => {
    const c = decodeDescriptor(descriptor).capabilities;
    expect(c.memory).toBeUndefined();
    expect(supportsMemoryProtocol(c)).toBe(false);
  });
  it("decodes future memory protocol but disables support", () => {
    const c = decodeDescriptor({
      ...descriptor,
      capabilities: { memory: { protocolVersion: 2 }, memoryHubProtocolVersion: 2 },
    }).capabilities;
    expect(c.memory?.protocolVersion).toBe(2);
    expect(supportsMemoryProtocol(c)).toBe(false);
  });
  it("enables only protocol one", () => {
    for (const protocolVersion of [0, 1, 2]) {
      const c = decodeDescriptor({
        ...descriptor,
        capabilities: { memory: { protocolVersion } },
      }).capabilities;
      expect(supportsMemoryProtocol(c)).toBe(protocolVersion === 1);
      expect(c.memory?.hub).toBeUndefined();
      expect(c.memory?.importProvider).toBeUndefined();
    }
  });
});
