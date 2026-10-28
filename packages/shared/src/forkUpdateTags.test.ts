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
});
