import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No fixed port: `pnpm dev` (tools/dev.mjs) picks free ports per worktree and passes the API's URL here.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The grid viewer reads zarr in a module worker.
  worker: { format: "es" },
  // Set by pnpm dev; unused by build.
  server: {
    proxy: {
      "/api": process.env.VOLUMA_API_URL as string,
      "/health": process.env.VOLUMA_API_URL as string,
    },
  },
});
