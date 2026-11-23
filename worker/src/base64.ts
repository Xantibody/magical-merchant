/// Adding one byte at a time to a string means 260,000 concatenations for a single
/// glyph (a png reaches 256 KiB under core's `GLYPH_MAX_BYTES`). The Workers Free plan
/// gives 10 ms of CPU per invocation, and a few glyphs in one bulk reach it. Handing a
/// whole chunk to `String.fromCharCode` brings the concatenations down to the number of
/// chunks (32 at 256 KiB).
///
/// They are not all passed at once because of the argument limit of
/// `Function.prototype.apply`. The limit is up to the engine (V8 raises a `RangeError`
/// somewhere between tens of thousands and a hundred-odd thousand), so passing 256 KiB
/// in one call hits it. 8 KiB is on the safe side of every implementation.
const CHUNK_BYTES = 8 * 1024;

/// AIDEV-NOTE: chunks are passed with `apply`. `String.fromCharCode(...chunk)` is the
/// same shape but 7x slower on workerd (4.4 ms against 0.6 ms at 256 KiB).
export function base64Encode(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < arr.length; offset += CHUNK_BYTES) {
    const chunk = arr.subarray(offset, offset + CHUNK_BYTES);
    // The input is bytes 0..255, so the only difference from `fromCodePoint` is
    // surrogates, which do not come up here. On workerd `fromCharCode` is 2 to 3 times
    // faster.
    // oxlint-disable-next-line unicorn/prefer-code-point
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/// AIDEV-NOTE: decode does not concatenate (the length is known, so it can allocate up
/// front) and so is not chunked. `Uint8Array.from(binary, ...)` is more than 20x slower
/// on workerd (9 to 17 ms against 0.4 ms at 256 KiB).
export function base64Decode(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
}
