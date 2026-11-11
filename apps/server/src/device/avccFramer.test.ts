// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - reads a binary fixture and a real loopback server.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  AnnexBFramer,
  avcDecoderConfiguration,
  envelope,
  type FramedChunk,
  spsFrameSize,
} from "./avccFramer.ts";

// Four 320x180 frames (K D K D) from ffmpeg's synthetic test source, encoded with the arguments
// FfmpegDesktopCapture uses: libx264 zerolatency writes three slices per frame, with 3- and 4-byte
// start codes and the parameter sets repeated before each keyframe.
const fixture = new Uint8Array(
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", "desktop-320x180.h264")),
);

const frame = (input: Uint8Array, chunkSize: number) => {
  const framer = new AnnexBFramer();
  const out: Array<FramedChunk> = [];
  for (let offset = 0; offset < input.length; offset += chunkSize)
    out.push(...framer.push(input.subarray(offset, offset + chunkSize)));
  out.push(...framer.flush());
  return { out, framer };
};

/** NAL unit types in a frame payload, which must be 4-byte lengths and never start codes. */
const nalTypes = (payload: Uint8Array) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const types: Array<number> = [];
  for (let offset = 0; offset < payload.length;) {
    const length = view.getUint32(offset);
    types.push(payload[offset + 4]! & 0x1f);
    offset += 4 + length;
    if (offset > payload.length) throw new Error("A NAL length runs past the payload.");
  }
  return types;
};

describe("serve-sim AVCC envelopes", () => {
  // The same vectors as native/device-capture's FormatTests.
  it("frames like the Swift helper", () => {
    expect([...envelope(4, Uint8Array.of(0xaa, 0xbb))]).toEqual([0, 0, 0, 3, 4, 0xaa, 0xbb]);
    expect([...envelope(1, Uint8Array.of(1, 0x64, 0, 0x1f))]).toEqual([
      0, 0, 0, 5, 1, 1, 0x64, 0, 0x1f,
    ]);
    expect([...envelope(2, new Uint8Array(0))]).toEqual([0, 0, 0, 1, 2]);
    expect([...envelope(3, new Uint8Array(0x01_02_03).fill(7)).subarray(0, 5)]).toEqual([
      0, 0x01, 0x02, 0x04, 3,
    ]);
    const pps = Uint8Array.of(0x68, 0xee, 0x3c, 0x80);
    expect([...avcDecoderConfiguration(Uint8Array.of(0x67, 0x4d, 0x40, 0x1f, 0xab), pps)!]).toEqual(
      [
        1, 0x4d, 0x40, 0x1f, 0xff, 0xe1, 0, 5, 0x67, 0x4d, 0x40, 0x1f, 0xab, 1, 0, 4, 0x68, 0xee,
        0x3c, 0x80,
      ],
    );
    expect([
      ...avcDecoderConfiguration(Uint8Array.of(0x67, 0x64, 0, 0x28), pps)!.subarray(-4),
    ]).toEqual([0xfd, 0xf8, 0xf8, 0]);
    expect(avcDecoderConfiguration(Uint8Array.of(0x67), pps)).toBeNull();
    expect(
      avcDecoderConfiguration(Uint8Array.of(0x67, 0x4d, 0x40, 0x1f), new Uint8Array(0)),
    ).toBeNull();
  });
});

describe("AnnexBFramer", () => {
  const whole = frame(fixture, fixture.length);

  it("emits one description, then whole frames with every slice", () => {
    expect(whole.out.map((chunk) => chunk.tag)).toEqual([1, 2, 3, 2, 3]);
    expect(whole.framer.size).toEqual({ width: 320, height: 180 });
    const [description, firstKey, delta, secondKey] = whole.out;
    expect(description!.payload[0]).toBe(1);
    // SEI and three IDR slices; then three slices; parameter sets travel only in the description.
    expect(nalTypes(firstKey!.payload)).toEqual([6, 5, 5, 5]);
    expect(nalTypes(delta!.payload)).toEqual([1, 1, 1]);
    expect(nalTypes(secondKey!.payload)).toEqual([5, 5, 5]);
  });

  it.each([1, 2, 3, 5, 7, 64, 1000, 4096])(
    "gives the same envelopes when stdout arrives in %i-byte chunks",
    (size) => {
      expect(frame(fixture, size).out).toEqual(whole.out);
    },
  );

  it("waits for parameter sets and a keyframe when it joins mid-stream", () => {
    // The fixture's second delta frame starts at its fourth picture start code with first_mb 0.
    const starts: Array<number> = [];
    for (let i = 0; i + 4 < fixture.length; i++) {
      if (fixture[i] === 0 && fixture[i + 1] === 0 && fixture[i + 2] === 1) {
        const type = fixture[i + 3]! & 0x1f;
        if ((type === 1 || type === 5) && (fixture[i + 4]! & 0x80) !== 0) starts.push(i);
        i += 2;
      }
    }
    const fromDelta = frame(fixture.subarray(starts[1]!), 4096);
    expect(fromDelta.out.map((chunk) => chunk.tag)).toEqual([1, 2, 3]);
  });

  it("gives up on a truncated SPS", () => {
    expect(spsFrameSize(Uint8Array.of(0x67, 0x42))).toBeNull();
  });
});
