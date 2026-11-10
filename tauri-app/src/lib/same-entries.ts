/**
 * Whether two tables hold the same keys with the same values, in any order.
 *
 * A table rebuilt from a re-read is a new object even when nothing in it moved, and whatever
 * is keyed on it (the preview's render, each TagText) runs again. Given to a signal or a memo
 * as `equals`, this keeps the table already held, so only a real change gets through.
 */
export function sameEntries<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    if (!b.has(key) || b.get(key) !== value) {
      return false;
    }
  }
  return true;
}
