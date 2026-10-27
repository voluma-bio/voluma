import { viteCommonjs } from "@originjs/vite-plugin-commonjs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No fixed port: each worktree's dev server takes the next free one, so parallel agents never collide.
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
});
