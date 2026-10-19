import type { Env as WorkerEnv } from "../src/env.js";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging
    interface Env extends WorkerEnv {}
  }
}
