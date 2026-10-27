import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No fixed port: each worktree's dev server takes the next free one, so parallel agents never collide.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
