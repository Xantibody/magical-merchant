import { vi } from "vitest";

export const invoke = vi.fn<(command: string, args?: unknown) => Promise<unknown>>();
