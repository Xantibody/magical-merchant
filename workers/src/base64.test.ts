import { describe, it, expect } from "vitest";
import { base64Decode, base64Encode } from "./base64";

/// The plain version that builds up one byte at a time. Readability is all it has going
/// for it, and the answer does not change however far the implementation is reshaped:
/// it is here as the yardstick.
function referenceEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

function referenceDecode(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
}

/// A linear congruential generator. It builds the same 256 KiB every run, so a failing
/// test always reproduces.
function pseudoRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let seed = 123_456_789;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[i] = (seed >>> 24) & 255;
  }
  return bytes;
}

function everyByteValue(): Uint8Array {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = i;
  }
  return bytes;
}

const KIB = 1024;

/// The boundaries are the 8 KiB chunk (one byte either side) and the 256 KiB glyph cap
/// (`GLYPH_MAX_BYTES`). 0 / 1 / 3 bytes are there as base64's own boundaries.
const CASES = [
  { name: "0 bytes", bytes: new Uint8Array(0) },
  { name: "1 byte", bytes: Uint8Array.of(255) },
  { name: "3 bytes", bytes: Uint8Array.of(0, 127, 128) },
  { name: "every byte value", bytes: everyByteValue() },
  { name: "8 KiB - 1", bytes: pseudoRandomBytes(8 * KIB - 1) },
  { name: "8 KiB", bytes: pseudoRandomBytes(8 * KIB) },
  { name: "8 KiB + 1", bytes: pseudoRandomBytes(8 * KIB + 1) },
  { name: "256 KiB", bytes: pseudoRandomBytes(256 * KIB) },
];

describe("base64", () => {
  it.each(CASES)("restores $name unchanged", ({ bytes }) => {
    expect(base64Decode(base64Encode(bytes.buffer))).toStrictEqual(bytes);
  });

  it.each(CASES)("encodes $name like the byte-at-a-time reference", ({ bytes }) => {
    expect(base64Encode(bytes.buffer)).toBe(referenceEncode(bytes));
  });

  it.each(CASES)("decodes $name like the byte-at-a-time reference", ({ bytes }) => {
    const encoded = referenceEncode(bytes);
    expect(base64Decode(encoded)).toStrictEqual(referenceDecode(encoded));
  });
});
