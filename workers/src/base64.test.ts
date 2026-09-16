import { describe, it, expect } from "vitest";
import { base64Decode, base64Encode } from "./base64";

/// 1 バイトずつ組み立てる素朴な版。読みやすさだけが取り柄で、実装が
/// どれだけ形を変えても答えは変わらない — 比較の物差しとして置いている。
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

/// 線形合同法。256 KiB を毎回同じ並びで作るので、落ちたテストは必ず再現する。
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

/// 境界は chunk の 8 KiB(前後 1 バイト)と、glyph の上限 256 KiB
/// (`GLYPH_MAX_BYTES`)。base64 自体の境界として 0 / 1 / 3 バイトも見る。
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
