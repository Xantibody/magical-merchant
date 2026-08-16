/**
 * テストは日本語で走る。
 *
 * 言語は端末の設定から決まる(`i18n.ts`)ので、そのままだと画面の文言を
 * 見るテストが「実行した端末の言語」で結果を変える。ここで固定して、
 * 英語を見たいテストだけが自分で `setLocale("en")` と言うようにする。
 */

import { beforeEach } from "vitest";
import { setLocale } from "./lib/i18n";

beforeEach(() => setLocale("ja"));
