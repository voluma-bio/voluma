import { viteCommonjs } from "@originjs/vite-plugin-commonjs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No fixed port: `pnpm dev` (tools/dev.mjs) picks free ports per worktree and passes the API's URL here.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteCommonjs()],
  // Preserve the DICOM loader's worker and WASM URLs instead of prebundling them.
  optimizeDeps: {
    exclude: ["@cornerstonejs/dicom-image-loader"],
    include: [
      "@voluma/viewer > dicom-parser",
      "@voluma/viewer > @zip.js/zip.js",
      "@voluma/viewer > @cornerstonejs/core",
    ],
  },
  worker: { format: "es" },
  server: { proxy: process.env.VOLUMA_API_URL ? { "/api": process.env.VOLUMA_API_URL } : {} },
});
