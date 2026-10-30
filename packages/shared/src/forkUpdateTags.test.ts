import { describe, expect, it } from "vite-plus/test";

import {
  findAppBundle,
  inferChannel,
  latestChannelTag,
  parseMountPoint,
} from "./forkUpdateTags.ts";

const tags = [
  "v0.1.2",
  "v0.1.10",
  "v0.1.3",
  "v0.1.4-nightly.20261028.3824",
  "v0.1.4-nightly.20261028.3900",
  "v0.1.4-nightly.20261027.9999",
  "v0.2.0-preview.20261029.1",
];

describe("fork update tags", () => {
  it("picks the latest stable tag by semver and skips nightly and preview", () => {
    expect(latestChannelTag(tags, "stable")).toBe("v0.1.10");
    expect(latestChannelTag(["v0.1.4-nightly.20261028.3824"], "stable")).toBeNull();
  });

  it("picks the latest nightly by version, date then build", () => {
    expect(latestChannelTag(tags, "nightly")).toBe("v0.1.4-nightly.20261028.3900");
    expect(latestChannelTag(["v0.1.3"], "nightly")).toBeNull();
  });

  it("infers the channel from the desktop version", () => {
    expect(inferChannel("0.1.3")).toBe("stable");
    expect(inferChannel("0.1.4-nightly.20261028.3824")).toBe("nightly");
  });

  it("finds the single app bundle and the mount point", () => {
    expect(findAppBundle([".background", "T3 Code (Beta).app", "Applications"])).toBe(
      "T3 Code (Beta).app",
    );
    expect(findAppBundle(["a.app", "b.app"])).toBeNull();
    expect(parseMountPoint("/dev/disk4s1\tApple_HFS\t/Volumes/T3 Code (Beta) 0.1.3\n")).toBe(
      "/Volumes/T3 Code (Beta) 0.1.3",
    );
  });

  it("compares numbers, not text, ignores anything that is not a release tag, and ignores order", () => {
    const shuffled = ["v0.9.0", " v0.10.0\n", "v0.2.100", "", "v1.2", "V9.9.9", "v9.9.9-rc.1", "x"];
    expect(latestChannelTag(shuffled, "stable")).toBe("v0.10.0");
    expect(latestChannelTag(shuffled.toReversed(), "stable")).toBe("v0.10.0");
    expect(latestChannelTag([], "stable")).toBeNull();
    expect(latestChannelTag(["v9.9.9-rc.1", "v1.2.3-nightly.2026.1"], "nightly")).toBeNull();
    // The version outranks the nightly date, then the date outranks the build.
    expect(
      latestChannelTag(
        ["v0.1.4-nightly.20261230.9", "v0.2.0-nightly.20260101.1", "v0.2.0-nightly.20260101.10"],
        "nightly",
      ),
    ).toBe("v0.2.0-nightly.20260101.10");
    expect(latestChannelTag(["v0.1.3", "v0.1.3"], "stable")).toBe("v0.1.3");
  });

  it("finds no bundle or mount point where the output has none", () => {
    expect(findAppBundle([])).toBeNull();
    expect(findAppBundle(["Applications", "readme.txt"])).toBeNull();
    expect(parseMountPoint("")).toBeNull();
    expect(parseMountPoint("/dev/disk4\tGUID_partition_scheme\t\n")).toBeNull();
    expect(
      parseMountPoint("/dev/disk4s1\tApple_HFS\t/Volumes/A\n/dev/disk4s2\tApple_HFS\t/Volumes/B\n"),
    ).toBe("/Volumes/B");
  });
});
