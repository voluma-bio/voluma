/**
 * The workflows screen (`/`): the workflow, the scan to run it on, "What do you want measured?"
 * and optional notes. Run starts it and opens the live run.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, listInputs, listRuns, startRun } from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import type { Input, VisitorKeys } from "@voluma/contracts/run";
import { Button, Card } from "@voluma/ui";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router";
import { KeysForm, loadKeys } from "./keys";
import { runHref } from "./runs-page";
import { RunBadge, runStatus } from "./status";
import { ALL_OUTPUT_IDS, OUTPUT_GROUPS, WORKFLOW, workflowName } from "./workflows";

const NOTES_MAX = 4000;

/** What the API's refusals mean to the user; anything else is a failure to reach it. */
function startError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "That scan or workflow is no longer available.";
    if (error.status === 409)
      return "You already have a run going. Wait for it to finish or stop it.";
    if (error.status === 429) return "The run limit is reached for now. Try again later.";
  }
  return "Couldn't start the run. Try again.";
}

export function StartPage() {
  const me = useOutletContext<Me>();
  const navigate = useNavigate();
  const inputs = useQuery({ queryKey: ["inputs"], queryFn: listInputs });
  const [picked, setPicked] = useState<string>();
  const [selected, setSelected] = useState(() => new Set(ALL_OUTPUT_IDS));
  const [notes, setNotes] = useState("");
  const [keys, setKeys] = useState<VisitorKeys | undefined>(loadKeys);
  const needsKeys = me.kind === "visitor";

  // The newest scan unless the user picked another.
  const inputId = picked ?? inputs.data?.[0]?.id;
  const start = useMutation({
    mutationFn: () =>
      startRun({
        workflowId: WORKFLOW.id,
        inputId: inputId as string,
        selectedOutputs: ALL_OUTPUT_IDS.filter((id) => selected.has(id)),
        notes: notes.trim() === "" ? undefined : notes,
        keys: needsKeys ? keys : undefined,
      }),
    onSuccess: (run) => navigate(`/runs/${run.id}/live`),
  });

  const canRun = inputId !== undefined && selected.size > 0 && (!needsKeys || keys !== undefined);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canRun) start.mutate();
  }

  return (
    <form
      onSubmit={submit}
      className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)_22rem] max-[1100px]:block"
    >
      <aside className="overflow-y-auto border-r border-border p-4 max-[1100px]:border-r-0 max-[1100px]:border-b">
        <h2 className="px-1 pb-3 text-meta font-semibold text-fg-subtle">Workflows</h2>
        <Card className="border-primary p-3">
          <p className="font-medium">{WORKFLOW.name}</p>
          <p className="text-meta text-muted-foreground">{ALL_OUTPUT_IDS.length} outputs</p>
        </Card>
      </aside>

      <section className="min-w-0 overflow-y-auto px-10 py-8 max-[1100px]:px-5">
        <h1 className="text-2xl font-semibold">{WORKFLOW.name}</h1>
        <p className="mt-1 text-muted-foreground">{WORKFLOW.description}</p>

        <h2 className="mt-8 text-lg font-semibold">What do you want measured?</h2>
        <div className="mt-2 flex items-center gap-3 text-ui text-muted-foreground">
          <span>
            {selected.size} of {ALL_OUTPUT_IDS.length} selected
          </span>
          <button
            type="button"
            className="text-primary-text hover:underline"
            onClick={() => setSelected(new Set(ALL_OUTPUT_IDS))}
          >
            Select all
          </button>
          <button
            type="button"
            className="text-primary-text hover:underline"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>

        <div className="mt-4 grid gap-4">
          {OUTPUT_GROUPS.map((group) => {
            const ids = group.outputs.map((o) => o.id);
            const count = ids.filter((id) => selected.has(id)).length;
            return (
              <fieldset key={group.title} className="rounded-xl border border-border bg-card p-4">
                <legend className="sr-only">{group.title}</legend>
                <label className="flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={count === ids.length}
                    ref={(el) => {
                      if (el) el.indeterminate = count > 0 && count < ids.length;
                    }}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const id of ids) e.target.checked ? next.add(id) : next.delete(id);
                        return next;
                      })
                    }
                  />
                  {group.title}
                  <span className="text-meta font-normal text-fg-subtle">
                    {count} of {ids.length}
                  </span>
                </label>
                <ul className="mt-2 grid grid-cols-2 gap-x-6 max-[1300px]:grid-cols-1">
                  {group.outputs.map((o) => (
                    <li key={o.id}>
                      <label className="flex items-baseline gap-2 py-1 text-ui">
                        <input
                          type="checkbox"
                          className="size-4 translate-y-0.5 accent-primary"
                          checked={selected.has(o.id)}
                          onChange={(e) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(o.id);
                              else next.delete(o.id);
                              return next;
                            })
                          }
                        />
                        <span className="min-w-0 flex-1">{o.name}</span>
                        <span className="font-mono text-meta text-fg-subtle">
                          {o.kind === "measurement" ? o.unit : "file"}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            );
          })}
        </div>

        <label className="mt-8 grid gap-1.5">
          <span className="text-lg font-semibold">Notes</span>
          <textarea
            value={notes}
            maxLength={NOTES_MAX}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Anything the agent should know about this scan (optional)"
            className="w-full rounded-lg border border-input bg-card p-3 text-ui outline-none focus-visible:border-ring"
          />
          <span className="text-meta text-fg-subtle">
            {notes.length} / {NOTES_MAX}
          </span>
        </label>
      </section>

      <aside className="flex min-h-0 flex-col gap-6 overflow-y-auto border-l border-border p-5 max-[1100px]:border-l-0 max-[1100px]:border-t">
        <ScanPicker inputs={inputs} inputId={inputId} onPick={setPicked} />

        {needsKeys && (
          <section>
            <h2 className="mb-2 text-meta font-semibold text-fg-subtle">Your keys</h2>
            {keys ? (
              <p className="text-ui text-muted-foreground">
                Saved in this browser.{" "}
                <button
                  type="button"
                  className="text-primary-text hover:underline"
                  onClick={() => setKeys(undefined)}
                >
                  Change
                </button>
              </p>
            ) : (
              <KeysForm submitLabel="Save keys" onSubmit={setKeys} />
            )}
          </section>
        )}

        <div>
          <Button
            type="submit"
            variant="primary"
            className="w-full"
            disabled={!canRun || start.isPending}
          >
            {start.isPending ? "Starting…" : "Run"}
          </Button>
          {selected.size === 0 && (
            <p className="mt-2 text-meta text-muted-foreground">Select at least one output.</p>
          )}
          {start.isError && (
            <p role="alert" className="mt-2 text-ui text-destructive">
              {startError(start.error)}
            </p>
          )}
        </div>

        <RecentRuns />
      </aside>
    </form>
  );
}

function ScanPicker({
  inputs,
  inputId,
  onPick,
}: {
  inputs: ReturnType<typeof useQuery<Input[]>>;
  inputId: string | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <section>
      <h2 className="mb-2 text-meta font-semibold text-fg-subtle">Scan</h2>
      {inputs.isPending && <p className="text-ui text-muted-foreground">Loading scans…</p>}
      {inputs.isError && (
        <p role="alert" className="text-ui text-destructive">
          Couldn't load scans.{" "}
          <button type="button" className="underline" onClick={() => void inputs.refetch()}>
            Try again
          </button>
        </p>
      )}
      {inputs.data?.length === 0 && (
        <p className="text-ui text-muted-foreground">No scans yet. A run needs a scan to read.</p>
      )}
      <div role="radiogroup" aria-label="Scan" className="grid gap-2">
        {inputs.data?.map((input) => (
          <label
            key={input.id}
            className={`flex cursor-pointer items-center gap-3 rounded-xl border bg-card p-3 ${
              input.id === inputId ? "border-primary" : "border-border hover:border-line-strong"
            }`}
          >
            <input
              type="radio"
              name="scan"
              className="size-4 accent-primary"
              checked={input.id === inputId}
              onChange={() => onPick(input.id)}
            />
            <span className="min-w-0 flex-1 truncate font-medium">{input.name}</span>
            {input.source === "reference" && (
              <span className="text-meta text-fg-subtle">Reference</span>
            )}
          </label>
        ))}
      </div>
    </section>
  );
}

function RecentRuns() {
  const runs = useQuery({ queryKey: ["runs"], queryFn: listRuns });
  const recent = runs.data?.slice(0, 4) ?? [];
  if (recent.length === 0) return null;
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-meta font-semibold text-fg-subtle">Recent runs</h2>
        <Link to="/runs" className="text-meta text-primary-text hover:underline">
          All runs
        </Link>
      </div>
      <ul className="grid gap-1">
        {recent.map((run) => (
          <li key={run.id}>
            <Link
              to={runHref(run)}
              className="flex items-center gap-3 rounded-lg p-2 hover:bg-accent"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{run.input.name}</span>
                <span className="block truncate text-meta text-muted-foreground">
                  {workflowName(run.workflows[0]?.path)}
                  {runStatus(run).detail ? `, ${runStatus(run).detail}` : ""}
                </span>
              </span>
              <RunBadge run={run} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
