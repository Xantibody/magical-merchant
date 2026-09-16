/// 1 バイトずつ文字列に足していくと、glyph(png は core の `GLYPH_MAX_BYTES`
/// で 256 KiB まで)1 枚で 26 万回の連結になる。Workers の Free プランは
/// 1 呼び出しあたり CPU 10 ms で、bulk 1 回に glyph が数枚載るとそこに届く。
/// まとめて `String.fromCharCode` に渡せば、連結は chunk の数(256 KiB で
/// 32 回)で済む。
///
/// 一度に全部渡さないのは `Function.prototype.apply` の引数上限のため。
/// 上限はエンジン任せ(V8 は数万〜十数万個で `RangeError`)なので、256 KiB を
/// 1 回で渡すとそこに当たる。8 KiB はどの実装でも安全側。
const CHUNK_BYTES = 8 * 1024;

/// AIDEV-NOTE: chunk は `apply` で渡す。`String.fromCharCode(...chunk)` は
/// 同じ形だが workerd で 7 倍遅い(256 KiB で 4.4 ms 対 0.6 ms)。
export function base64Encode(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < arr.length; offset += CHUNK_BYTES) {
    const chunk = arr.subarray(offset, offset + CHUNK_BYTES);
    // 入力は 0..255 のバイトなので `fromCodePoint` との差はサロゲートだけで、
    // ここでは出ない。workerd では `fromCharCode` が 2〜3 倍速い。
    // oxlint-disable-next-line unicorn/prefer-code-point
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/// AIDEV-NOTE: decode は連結しない(長さが分かるので先に確保できる)ので
/// chunk 化しない。`Uint8Array.from(binary, …)` は workerd で 20 倍以上遅い
/// (256 KiB で 9〜17 ms 対 0.4 ms)。
export function base64Decode(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
}
