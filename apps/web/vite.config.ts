import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // `wrangler dev` serves the Worker (API + bridge) on :8787; API_TARGET overrides it.
  const { API_TARGET } = loadEnv(mode, ".", "API_");
  return {
    plugins: [react()],
    server: {
      proxy: { "/api": { target: API_TARGET ?? "http://localhost:8787", ws: true } },
    },
  };
});
