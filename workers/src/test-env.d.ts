import type { Env } from "./index";

declare module "cloudflare:test" {
  // Module augmentation merges into `cloudflare:test`'s own `ProvidedEnv`
  // interface, so a type alias cannot be used and the body has to stay empty.
  // oxlint-disable-next-line typescript/no-empty-interface
  interface ProvidedEnv extends Env {}
}
