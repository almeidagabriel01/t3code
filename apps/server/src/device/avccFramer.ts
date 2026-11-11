/**
 * Re-frames an H.264 Annex B byte stream (ffmpeg's `-f h264`) into serve-sim's AVCC stream, the
 * format `native/device-capture` serves: `[u32 big-endian length][tag][payload]`, where the length
 * counts the tag, a description is an `avcC` record, and a frame is its NAL units behind 4-byte
 * lengths.
 */
export const AVCC_TAG = { description: 1, keyframe: 2, delta: 3 } as const;

export const envelope = (tag: number, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(payload.length + 5);
  new DataView(out.buffer).setUint32(0, payload.length + 1);
  out[4] = tag;
  out.set(payload, 5);
  return out;
};

/** The `avcC` record a WebCodecs decoder takes as its description, with 4-byte NAL lengths. */
export const avcDecoderConfiguration = (sps: Uint8Array, pps: Uint8Array): Uint8Array | null => {
  if (sps.length < 4 || sps.length > 0xffff || pps.length === 0 || pps.length > 0xffff) return null;
  const high = [100, 110, 122, 144].includes(sps[1]!);
  const out = new Uint8Array(11 + sps.length + pps.length + (high ? 4 : 0));
  out.set([1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1, sps.length >> 8, sps.length & 0xff]);
  out.set(sps, 8);
  out.set([1, pps.length >> 8, pps.length & 0xff], 8 + sps.length);
  out.set(pps, 11 + sps.length);
  // High profiles carry the chroma format and bit depths: 4:2:0, 8-bit, no SPS extensions.
  if (high) out.set([0xfd, 0xf8, 0xf8, 0], 11 + sps.length + pps.length);
  return out;
};

class BitReader {
  private bit = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.bit >> 3];
      if (byte === undefined) throw new RangeError("SPS ended early");
      value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return value;
  }
  ue(): number {
    let zeros = 0;
    while (this.read(1) === 0) {
      if (++zeros > 31) throw new RangeError("Bad exp-Golomb code");
    }
    return 2 ** zeros - 1 + this.read(zeros);
  }
  se(): number {
    const value = this.ue();
    return value % 2 === 0 ? -(value / 2) : (value + 1) / 2;
  }
}

const unescape = (nal: Uint8Array): Uint8Array => {
  const out: Array<number> = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]!);
  }
  return Uint8Array.from(out);
};

const skipScalingList = (reader: BitReader, size: number) => {
  let last = 8;
  let next = 8;
  for (let i = 0; i < size; i++) {
    if (next !== 0) next = (last + reader.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
};

/** The displayed frame size an SPS NAL unit (header byte included) declares, or null. */
export const spsFrameSize = (sps: Uint8Array): { width: number; height: number } | null => {
  try {
    const reader = new BitReader(unescape(sps.subarray(1)));
    const profile = reader.read(8);
    reader.read(16);
    reader.ue();
    let chromaFormat = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chromaFormat = reader.ue();
      if (chromaFormat === 3) reader.read(1);
      reader.ue();
      reader.ue();
      reader.read(1);
      if (reader.read(1) === 1) {
        for (let i = 0; i < (chromaFormat === 3 ? 12 : 8); i++) {
          if (reader.read(1) === 1) skipScalingList(reader, i < 6 ? 16 : 64);
        }
      }
    }
    reader.ue();
    const pocType = reader.ue();
    if (pocType === 0) reader.ue();
    else if (pocType === 1) {
      reader.read(1);
      reader.se();
      reader.se();
      const cycle = reader.ue();
      for (let i = 0; i < cycle; i++) reader.se();
    }
    reader.ue();
    reader.read(1);
    const widthInMbs = reader.ue() + 1;
    const heightInMapUnits = reader.ue() + 1;
    const frameMbsOnly = reader.read(1);
    if (frameMbsOnly === 0) reader.read(1);
    reader.read(1);
    const crop = reader.read(1) === 1 ? [reader.ue(), reader.ue(), reader.ue(), reader.ue()] : null;
    const cropX = chromaFormat === 0 || chromaFormat === 3 ? 1 : 2;
    const cropY = (chromaFormat === 1 ? 2 : 1) * (2 - frameMbsOnly);
    const width = widthInMbs * 16 - (crop ? (crop[0]! + crop[1]!) * cropX : 0);
    const height =
      (2 - frameMbsOnly) * heightInMapUnits * 16 - (crop ? (crop[2]! + crop[3]!) * cropY : 0);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
};

const sameBytes = (a: Uint8Array | null, b: Uint8Array) =>
  a !== null && a.length === b.length && a.every((byte, i) => byte === b[i]);

export interface FramedChunk {
  readonly tag: number;
  readonly payload: Uint8Array;
}

/**
 * Feed it stdout chunks; it returns whole envelopes. A frame is only known to be complete when the
 * next one starts, so output trails the encoder by one frame.
 */
// ponytail: one frame of latency (~33 ms at 30 fps); an AUD-driven flush could drop it if it matters.
export class AnnexBFramer {
  private buffer = new Uint8Array(0);
  private unit: Array<Uint8Array> = [];
  private unitHasPicture = false;
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private description: Uint8Array | null = null;
  private keyframeSeen = false;
  /** The frame size from the newest SPS. */
  size: { width: number; height: number } | null = null;

  push(chunk: Uint8Array): Array<FramedChunk> {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    const starts = startCodes(joined);
    const out: Array<FramedChunk> = [];
    // Each NAL runs to the next start code; the last one may still be arriving.
    for (let i = 0; i + 1 < starts.length; i++) {
      const nal = joined.subarray(starts[i]!.payload, starts[i + 1]!.code);
      if (nal.length > 0) this.nal(nal, out);
    }
    const last = starts.at(-1);
    this.buffer = last ? joined.slice(last.code) : joined.slice(Math.max(0, joined.length - 3));
    return out;
  }

  /** Emits the frame still held, at the end of the stream. */
  flush(): Array<FramedChunk> {
    const out: Array<FramedChunk> = [];
    const starts = startCodes(this.buffer);
    const last = starts.at(-1);
    if (last) this.nal(this.buffer.subarray(last.payload), out);
    this.buffer = new Uint8Array(0);
    this.emitUnit(out);
    return out;
  }

  private nal(nal: Uint8Array, out: Array<FramedChunk>) {
    const type = nal[0]! & 0x1f;
    const picture = type === 1 || type === 5;
    // An AUD, a parameter set, or a slice with first_mb_in_slice 0 begins a new frame.
    const startsFrame =
      type === 9 || type === 7 || type === 8 || (picture && (nal[1]! & 0x80) !== 0);
    if (startsFrame && this.unitHasPicture) this.emitUnit(out);
    if (type === 7) this.sps = nal.slice();
    else if (type === 8) this.pps = nal.slice();
    else if (type !== 9) {
      this.unit.push(nal.slice());
      if (picture) this.unitHasPicture = true;
    }
    if (type === 7 || type === 8) this.describe(out);
  }

  private describe(out: Array<FramedChunk>) {
    if (!this.sps || !this.pps) return;
    const record = avcDecoderConfiguration(this.sps, this.pps);
    if (!record || sameBytes(this.description, record)) return;
    this.description = record;
    this.size = spsFrameSize(this.sps);
    // A new description makes the decoder wait for a keyframe again.
    this.keyframeSeen = false;
    out.push({ tag: AVCC_TAG.description, payload: record });
  }

  private emitUnit(out: Array<FramedChunk>) {
    const nals = this.unit;
    const hasPicture = this.unitHasPicture;
    this.unit = [];
    this.unitHasPicture = false;
    if (!hasPicture || !this.description) return;
    const key = nals.some((nal) => (nal[0]! & 0x1f) === 5);
    if (key) this.keyframeSeen = true;
    if (!this.keyframeSeen) return;
    const payload = new Uint8Array(nals.reduce((total, nal) => total + 4 + nal.length, 0));
    const view = new DataView(payload.buffer);
    let offset = 0;
    for (const nal of nals) {
      view.setUint32(offset, nal.length);
      payload.set(nal, offset + 4);
      offset += 4 + nal.length;
    }
    out.push({ tag: key ? AVCC_TAG.keyframe : AVCC_TAG.delta, payload });
  }
}

/** Where each start code begins and where its NAL unit begins, for 3- and 4-byte codes. */
const startCodes = (bytes: Uint8Array) => {
  const found: Array<{ code: number; payload: number }> = [];
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    if (bytes[i + 2] === 1) {
      found.push({ code: i > 0 && bytes[i - 1] === 0 ? i - 1 : i, payload: i + 3 });
      i += 2;
    }
  }
  return found;
};
