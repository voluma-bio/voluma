/** Browser-only app; production hosting needs an index.html fallback for routes. */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
});
