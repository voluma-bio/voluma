/** Web app entry: global styles (fonts included), following deploys, and the router shell. */
import "./shell/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./shell/app";
import { followDeploys } from "./shell/deploys";

// The entry module's own URL: the bundle this tab runs, compared with the one `/` names.
followDeploys(import.meta.url);

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
