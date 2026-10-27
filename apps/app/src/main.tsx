/** Phase-one application shell; reports and service interactions follow separately. */
import { Group, Panel, Separator, ViewerWorkspace } from "@voluma/review";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";

const tasks = [
  "Segmentation",
  "Distal femur",
  "Tibial IIOC",
  "Trabecular IIOC",
  "Plate thickness",
];
function App() {
  const [task, setTask] = useState("Distal femur");
  return (
    <main className="review-app">
      <header className="app-header">voluma · Review · Demo workspace</header>
      <div className="run-header">
        <h1>OA6-1RK · Mouse OA knee</h1>
      </div>
      <div className="review-body">
        <aside className="review-sidebar">
          <nav aria-label="Workflow tasks">
            {tasks.map((title, index) => (
              <button
                type="button"
                className={`task-nav ${task === title ? "selected" : ""}`}
                key={title}
                onClick={() => setTask(title)}
              >
                <span className="task-number">{index + 1}</span>
                {title}
              </button>
            ))}
          </nav>
        </aside>
        <div className="review-panels">
          <Group orientation="horizontal">
            <Panel defaultSize="48%" minSize="32%">
              <article className="task-report">
                <h1>{task}</h1>
                <p>
                  Task report integration pending. Scientific images are not
                  included.
                </p>
              </article>
            </Panel>
            <Separator
              className="resize-handle"
              aria-label="Resize report and viewers"
            />
            <Panel>
              <ViewerWorkspace selected={[]} display={{}} />
            </Panel>
          </Group>
        </div>
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
