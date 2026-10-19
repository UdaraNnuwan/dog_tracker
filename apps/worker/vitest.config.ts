import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests must never reach a real broker: no HIVEMQ_* bindings => bridge stays "unconfigured".
      // The live view starts closed; tests opt in explicitly.
      miniflare: {
        bindings: {
          HIVEMQ_HOST: "",
          HIVEMQ_USERNAME: "",
          HIVEMQ_PASSWORD: "",
          LIVE_VIEW_UNAUTHENTICATED: "",
          // Storage stays off: tests must never write to a real Supabase project.
          SUPABASE_URL: "",
          SUPABASE_SECRET_KEY: "",
        },
      },
    }),
  ],
});
