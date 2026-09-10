import type { AuthEnv } from "../src/auth";

declare global {
  namespace Cloudflare {
    interface Env extends AuthEnv {}
  }
}

export {};
