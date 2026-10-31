/** Web app entry: global styles (fonts included), the reload-after-deploy guard and the router shell. */
import "./shell/styles.css";
import { onContractError } from "@voluma/api-client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./shell/app";

/**
 * A deploy replaces the web app and the API together, but an open tab keeps the old code: its
 * chunks may be gone and the API's responses may have a new shape. Either way, reloading picks up
 * the deployed code. Reload at most once per entry bundle in this tab, so a failure the new code
 * can't fix shows its error screen instead of looping. False when this bundle already reloaded.
 */
function reloadOnce(): boolean {
  try {
    const key = `voluma:deploy-reload:${import.meta.url}`;
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");
  } catch {
    // Without session storage, let the original error surface rather than loop.
    return false;
  }
  window.location.reload();
  return true;
}

window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnce()) event.preventDefault();
});
onContractError(() => reloadOnce());

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
