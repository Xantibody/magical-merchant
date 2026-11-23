// Steps that must not overlap, such as driving the one window there is.

export async function inOrder(steps: (() => Promise<void>)[]): Promise<void> {
  const [first, ...rest] = steps;
  if (first === undefined) {
    return;
  }
  await first();
  await inOrder(rest);
}
