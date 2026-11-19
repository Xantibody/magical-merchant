/**
 * Tests run in Japanese.
 *
 * The language comes from the device settings (`i18n.ts`), so left alone, a test
 * that looks at screen text changes its result with the language of the device
 * it runs on. It is fixed here, and only a test that wants English says
 * `setLocale("en")` itself.
 */

import { beforeEach } from "vitest";
import { setLocale } from "./lib/i18n";

beforeEach(() => setLocale("ja"));
