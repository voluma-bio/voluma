/** Fixture-backed reports before enabling review mutations and correction flows. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createDemoService,
  downloadCsv,
  Group,
  Panel,
  Separator,
  TaskReport,
  ViewerWorkspace,
} from "@voluma/review";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";

const queryClient = new QueryClient();
const demo = createDemoService();
const run = await demo.service.getRun("oa6-1rk");
const revision = run.revisions[0];
function App() {
  const [taskId, setTaskId] = useState("femur");
  const task =
    revision.tasks.find((item) => item.id === taskId) ?? revision.tasks[0];
  return (
    <main className="review-app">
      <header className="app-header">voluma · Review · Demo workspace</header>
      <div className="run-header">
        <h1>OA6-1RK · Mouse OA knee</h1>
        <button
          type="button"
          className="button"
          onClick={() => downloadCsv(run, revision)}
        >
          Export CSV
        </button>
      </div>
      <div className="review-body">
        <aside className="review-sidebar">
          <nav aria-label="Workflow tasks">
            {revision.tasks.map((item, index) => (
              <button
                type="button"
                className={`task-nav ${task.id === item.id ? "selected" : ""}`}
                key={item.id}
                onClick={() => setTaskId(item.id)}
              >
                <span className="task-number">{index + 1}</span>
                {item.title}
              </button>
            ))}
          </nav>
        </aside>
        <div className="review-panels">
          <Group orientation="horizontal">
            <Panel defaultSize="48%" minSize="32%">
              <div className="report-scroll" key={task.id}>
                <TaskReport
                  task={task}
                  taskNumber={revision.tasks.indexOf(task) + 1}
                  runId={run.id}
                  revisionId={revision.id}
                  readOnly
                  service={demo.service}
                  onResult={() => {}}
                  onCorrect={() => {}}
                />
              </div>
            </Panel>
            <Separator
              className="resize-handle"
              aria-label="Resize report and viewers"
            />
            <Panel>
              <ViewerWorkspace
                selected={revision.structures.filter((item) =>
                  task.structureIds.includes(item.id),
                )}
                display={{}}
              />
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
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
