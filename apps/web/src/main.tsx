/** Web app entry: global styles (fonts included) and the router shell. */
import "./shell/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./shell/app";

// A deploy can remove chunks an open tab has not loaded yet. Reload once per
// entry bundle in this tab; persistent failures must not cause a reload loop.
window.addEventListener("vite:preloadError", (event) => {
  try {
    const key = `voluma:preload-reload:${import.meta.url}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch {
    // Without session storage, let the original error surface rather than loop.
    return;
  }
  event.preventDefault();
  window.location.reload();
});

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
