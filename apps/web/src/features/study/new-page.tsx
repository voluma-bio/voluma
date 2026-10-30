/**
 * Run on new scans (`/new`): the scans first (dropped or picked, grouped by `scan-files.ts`,
 * uploading at once; or scans uploaded before), the intake table (`intake.ts`), the workflow,
 * then, for several scans, the study's name and how much runs now. One scan starts a study of
 * one named after it and opens its run; several start a study and open it.
 *
 * Uploads run while the researcher fills the rest. Start can be pressed before they finish: it
 * waits for them, says so, and starts when the last one completes (the page has to stay open).
 * A guest can't upload (the API refuses), so a guest picks an earlier scan and gives keys.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, createStudy, signIn } from "@voluma/api-client";
import { inputsQuery, runsQuery, studiesQuery } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import type { Input, Run, VisitorKeys } from "@voluma/contracts/run";
import type { CreateStudyRequest } from "@voluma/contracts/study";
import { formatDuration, formatUsd, loadKeys, RunKeyLine } from "@voluma/run-view";
import { Button, Disclosure, EmptyState, ErrorState, LoadingState, TextField } from "@voluma/ui";
import { catalog } from "@voluma/workflow/bundled";
import { FolderOpen, Upload, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router";
import { intake, type Knee, readSheet, type Sample, type Sheet, sheetRecognised } from "./intake";
import { type Dropped, fromDataTransfer, fromFileList, groupDropped } from "./scan-files";
import { formatBytes, type Progress, type UploadState, useSent, useUploads } from "./uploads";
import { measuredBy, measurementsOf, WorkflowPanel } from "./workflow-tasks";

/** The one workflow a study can use today, listed as a list of one. */
const WORKFLOWS = [catalog["mouse-oa"]];

/** A scan on the page: dropped here (uploading under `id`) or uploaded before. */
interface Row {
  id: string;
  name: string;
  /** Set for an earlier scan; a dropped one has its input once its upload is ready. */
  input?: Input;
  files?: { count: number; bytes: number };
  /** Cells the researcher typed; the rest come from `intake`. */
  edits: Partial<Sample>;
}

type SheetState =
  | { kind: "none" }
  | { kind: "reading"; name: string }
  | { kind: "read"; sheet: Sheet }
  | { kind: "error"; name: string };

function startError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403 && error.serverMessage) return error.serverMessage;
    if (error.status === 404) return "A scan or the workflow is no longer available.";
    if (error.status === 409)
      return "You already have a run going. Wait for it to finish or stop it, then start again.";
    if (error.status === 429) return "The run limit is reached for now. Try again later.";
  }
  return "Couldn't start. Try again.";
}

/** The lab's newest completed run of `path` (not a seeded example), for a time and cost it actually took. */
function lastCompleted(runs: Run[] | undefined, path: string) {
  for (const run of runs ?? []) {
    const { state } = run;
    if (
      !run.example &&
      state.status === "ended" &&
      state.outcome === "completed" &&
      state.startedAt &&
      run.usage &&
      run.workflows[0]?.path === path
    )
      return {
        seconds: (Date.parse(state.endedAt) - Date.parse(state.startedAt)) / 1000,
        usd: run.usage.modelCostUsd,
      };
  }
}

/** The pilot: the first scan of each of the first two groups, else the first two scans. */
function pilotOf(rows: { id: string; sample: Sample }[]): string[] {
  const firsts = new Map<string, string>();
  for (const r of rows) {
    const group = r.sample.group.trim();
    if (group && !firsts.has(group)) firsts.set(group, r.id);
  }
  const picked =
    firsts.size >= 2 ? [...firsts.values()].slice(0, 2) : rows.slice(0, 2).map((r) => r.id);
  return rows.filter((r) => picked.includes(r.id)).map((r) => r.id);
}

export function NewPage() {
  const me = useOutletContext<Me>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canUpload = me.kind === "member";
  const guest = me.kind === "visitor";

  const inputs = useQuery(inputsQuery());
  const runs = useQuery(runsQuery());
  const uploads = useUploads();
  const [rows, setRows] = useState<Row[]>([]);
  const [sheet, setSheet] = useState<SheetState>({ kind: "none" });
  const [skipped, setSkipped] = useState<string[]>([]);
  const [workflowId, setWorkflowId] = useState<string>(WORKFLOWS[0]?.id ?? "");
  const [panel, setPanel] = useState<string>();
  const [studyName, setStudyName] = useState("");
  const [pilot, setPilot] = useState(true);
  const [keys, setKeys] = useState<VisitorKeys | undefined>(() => loadKeys(me.userId));
  /** Start was pressed while scans were still uploading. */
  const [armed, setArmed] = useState(false);
  const nextId = useRef(0);

  const workflow = WORKFLOWS.find((w) => w.id === workflowId);
  const read = sheet.kind === "read" ? sheet.sheet : undefined;

  async function addDropped(dropped: Dropped[]) {
    const grouped = groupDropped(
      dropped,
      rows.map((r) => r.name),
    );
    setSkipped(grouped.skipped);
    const added = grouped.scans.map((scan) => {
      const id = `drop-${nextId.current++}`;
      uploads.add(id, scan.name, scan.files);
      return {
        id,
        name: scan.name,
        files: {
          count: scan.files.length,
          bytes: scan.files.reduce((sum, f) => sum + f.file.size, 0),
        },
        edits: {},
      } satisfies Row;
    });
    setRows((prev) => [...prev, ...added]);
    // The last sheet dropped is the one used.
    const file = grouped.sheets.at(-1);
    if (file) {
      setSheet({ kind: "reading", name: file.name });
      try {
        setSheet({ kind: "read", sheet: await readSheet(file) });
        if (!studyName.trim()) setStudyName(file.name.replace(/\.[^.]+$/, ""));
      } catch {
        setSheet({ kind: "error", name: file.name });
      }
    }
  }

  function toggleEarlier(input: Input, on: boolean) {
    setRows((prev) =>
      on
        ? [...prev, { id: `input-${input.id}`, name: input.name, input, edits: {} }]
        : prev.filter((r) => r.id !== `input-${input.id}`),
    );
  }

  function removeRow(id: string) {
    uploads.remove(id);
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  // What the name and sheet give each scan, before the researcher's edits: recomputed only
  // when the scans or the sheet change, not on an edit or an upload's state. Keyed on the
  // names joined by NUL, which no file name holds.
  const nameKey = rows.map((r) => r.name).join("\0");
  const parsed = useMemo(
    () => new Map(nameKey.split("\0").map((name) => [name, intake(name, read)])),
    [nameKey, read],
  );
  // Each row as the study will store it.
  const table = rows.map((row) => {
    const upload: UploadState | undefined = row.input ? undefined : uploads.states[row.id];
    const input = row.input ?? (upload?.kind === "ready" ? upload.input : undefined);
    return { ...row, input, upload, sample: { ...(parsed.get(row.name) as Sample), ...row.edits } };
  });
  const several = table.length > 1;
  const missing = several
    ? table.reduce(
        (n, r) =>
          n + [r.sample.subject, r.sample.knee, r.sample.group].filter((v) => !v.trim()).length,
        0,
      )
    : 0;
  const broken = table.filter((r) => r.upload?.kind === "failed" || r.upload?.kind === "error");
  const pending = table.filter((r) => !r.input && !broken.includes(r));
  const pilotIds = several && table.length > 2 ? pilotOf(table) : table.map((r) => r.id);
  const startIds = several && pilot ? pilotIds : table.map((r) => r.id);

  const blocker: string | undefined =
    table.length === 0
      ? undefined
      : broken.length > 0
        ? `${broken.length === 1 ? "A scan didn't" : `${broken.length} scans didn't`} upload. Retry or remove ${broken.length === 1 ? "it" : "them"} first.`
        : missing > 0
          ? `Fill in the ${missing === 1 ? "empty cell" : `${missing} empty cells`} first.`
          : several && !studyName.trim()
            ? "Name the study first."
            : !workflow
              ? "Choose a workflow first."
              : guest && !keys
                ? "Add your Meta key first."
                : undefined;

  const start = useMutation({
    mutationFn: () => {
      if (!workflow) throw new Error("no workflow");
      const request: CreateStudyRequest = {
        name: several ? studyName.trim() : table[0]?.name || "Scan",
        workflowId: workflow.id,
        scans: table.map(({ input, sample }) => ({
          inputId: (input as Input).id,
          ...(sample.subject.trim() && { subject: sample.subject.trim() }),
          ...(sample.group.trim() && { group: sample.group.trim() }),
          ...(sample.knee && { attributes: { knee: sample.knee } }),
        })),
        start: table.filter((r) => startIds.includes(r.id)).map((r) => (r.input as Input).id),
        keys,
      };
      return createStudy(request);
    },
    onSuccess: (detail) => {
      void queryClient.invalidateQueries({ queryKey: studiesQuery().queryKey });
      void queryClient.invalidateQueries({ queryKey: runsQuery().queryKey });
      const run = detail.scans[0]?.runs[0];
      navigate(
        detail.scans.length === 1 && run ? `/runs/${run.id}/live` : `/studies/${detail.study.id}`,
      );
    },
  });

  // Start as soon as the last upload lands; a scan that fails disarms it.
  const ready = table.length > 0 && pending.length === 0 && !blocker;
  useEffect(() => {
    if (!armed) return;
    if (blocker || table.length === 0) setArmed(false);
    else if (ready && !start.isPending && !start.isSuccess) {
      setArmed(false);
      start.mutate();
    }
  }, [armed, blocker, ready, start, table.length]);

  const estimate = workflow && lastCompleted(runs.data, workflow.path);
  const startLabel = several ? "Start the study" : "Start run";

  return (
    <div className="mx-auto grid w-full max-w-[860px] content-start gap-4 px-6 pt-7 pb-16 max-[760px]:px-4">
      <h1 className="mb-1 text-2xl font-semibold">Run on new scans</h1>

      <Step n={1} title="Scans">
        {canUpload ? (
          <DropZone compact={table.length > 0} onFiles={(d) => void addDropped(d)} />
        ) : (
          <p className="rounded-lg bg-muted px-4 py-3 text-ui">
            Uploading scans needs a lab account.{" "}
            <Button variant="link" onClick={() => signIn()}>
              Sign in
            </Button>{" "}
            or use a scan already here.
          </p>
        )}
        {skipped.length > 0 && (
          <p className="text-ui text-muted-foreground">
            Not used: {skipped.slice(0, 5).join(", ")}
            {skipped.length > 5 && ` and ${skipped.length - 5} more`}
          </p>
        )}
        <SheetLine
          sheet={sheet}
          matched={read ? rows.filter((r) => parsed.get(r.name)?.group).length : 0}
          total={table.length}
          onRemove={() => setSheet({ kind: "none" })}
        />
        {table.length > 0 && (
          <IntakeTable
            rows={table}
            several={several}
            onEdit={(id, edit) =>
              setRows((prev) =>
                prev.map((r) => (r.id === id ? { ...r, edits: { ...r.edits, ...edit } } : r)),
              )
            }
            onRemove={removeRow}
            onRetry={uploads.retry}
            progress={uploads.progress}
          />
        )}
        <Earlier
          inputs={inputs}
          open={!canUpload}
          chosen={new Set(rows.flatMap((r) => (r.input ? [r.input.id] : [])))}
          hidden={
            new Set(
              table.flatMap((r) => (!r.id.startsWith("input-") && r.input ? [r.input.id] : [])),
            )
          }
          onToggle={toggleEarlier}
        />
      </Step>

      <Step n={2} title="Choose a workflow">
        <div role="radiogroup" aria-label="Workflow" className="grid">
          {WORKFLOWS.map((w) => (
            <div key={w.id} className="flex items-center gap-3 py-1">
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="workflow"
                  className="mt-1 size-4 accent-primary"
                  checked={workflowId === w.id}
                  onChange={() => setWorkflowId(w.id)}
                />
                <span className="min-w-0">
                  <span className="block font-medium">{w.name}</span>
                  <span className="block text-ui text-muted-foreground">
                    {w.tasks.length} tasks, {measurementsOf(w).length} measurements
                  </span>
                  <span className="block text-ui text-muted-foreground">{measuredBy(w)}</span>
                </span>
              </label>
              <Button variant="link" className="text-ui" onClick={() => setPanel(w.id)}>
                See tasks
              </Button>
            </div>
          ))}
        </div>
      </Step>

      {several && (
        <Step n={3} title="Study">
          <TextField
            label="Name"
            className="max-w-md"
            value={studyName}
            maxLength={200}
            onChange={(e) => setStudyName(e.target.value)}
            placeholder="DMM knee study, Oct 2026"
          />
          {table.length > 2 && (
            <fieldset className="grid gap-2">
              <legend className="sr-only">What runs now</legend>
              <Choice
                checked={pilot}
                onChange={() => setPilot(true)}
                title={`Run ${pilotIds.length} first, then the rest`}
              >
                {table
                  .filter((r) => pilotIds.includes(r.id))
                  .map((r) => r.name)
                  .join(" and ")}{" "}
                run now. Check them; start the other {table.length - pilotIds.length} from the study
                page, so a change you make to the method reaches them.
              </Choice>
              <Choice
                checked={!pilot}
                onChange={() => setPilot(false)}
                title={`Run all ${table.length} now`}
              >
                They queue under your lab's limit on runs at once.
              </Choice>
            </fieldset>
          )}
        </Step>
      )}

      {estimate && table.length > 0 && (
        <p className="px-1 text-ui text-muted-foreground">
          The lab's last run of this workflow took {formatDuration(estimate.seconds)} and cost{" "}
          {formatUsd(estimate.usd)}
          {startIds.length > 1 &&
            `; ${startIds.length} runs at that rate cost about ${formatUsd(estimate.usd * startIds.length)}`}
          .
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
        <Button
          variant="primary"
          disabled={table.length === 0 || blocker !== undefined || armed || start.isPending}
          onClick={() => (pending.length > 0 ? setArmed(true) : start.mutate())}
        >
          {start.isPending ? "Starting…" : armed ? "Waiting for uploads…" : startLabel}
        </Button>
        <span role="status" className="text-ui text-muted-foreground">
          {table.length === 0
            ? "Add a scan to start."
            : (blocker ??
              (armed
                ? `Starts when ${pending.length === 1 ? "the last scan finishes" : `${pending.length} scans finish`} uploading. Keep this page open until then.`
                : pending.length > 0
                  ? pending.length === 1
                    ? "A scan is still uploading. Start now and it begins once the upload finishes."
                    : `${pending.length} scans are still uploading. Start now and they begin once the uploads finish.`
                  : "You can close this page once it starts; the runs carry on."))}
        </span>
        {start.isError && (
          <p role="alert" className="w-full text-ui text-destructive">
            {startError(start.error)}
          </p>
        )}
      </div>

      <div className="px-1">
        <RunKeyLine userId={me.userId} guest={guest} keys={keys} onChange={setKeys} />
      </div>

      {WORKFLOWS.map((w) => (
        <WorkflowPanel
          key={w.id}
          workflow={w}
          open={panel === w.id}
          onClose={() => setPanel(undefined)}
        />
      ))}
    </div>
  );
}

function Step({ n, title, children }: { n?: number; title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="grid gap-3 rounded-xl border border-border bg-card px-5 py-4 max-[760px]:px-4"
    >
      <h2 id={id} className="flex items-center gap-2.5 font-semibold">
        {n !== undefined && (
          <span className="grid size-5.5 place-items-center rounded-full bg-primary-tint text-meta text-primary-strong">
            {n}
          </span>
        )}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Choice({
  checked,
  onChange,
  title,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-2.5 ${checked ? "border-primary" : "border-border hover:border-line-strong"}`}
    >
      <input
        type="radio"
        name="pilot"
        className="mt-1 size-4 accent-primary"
        checked={checked}
        onChange={onChange}
      />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-ui text-muted-foreground">{children}</span>
      </span>
    </label>
  );
}

function DropZone({ compact, onFiles }: { compact: boolean; onFiles: (d: Dropped[]) => void }) {
  const [over, setOver] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const pick = (list: FileList | null) => {
    if (list && list.length > 0) onFiles(fromFileList(list));
  };
  return (
    <section
      aria-label="Drop scans"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        setUnreadable(false);
        void fromDataTransfer(e.dataTransfer).then(onFiles, () => setUnreadable(true));
      }}
      className={`grid justify-items-center gap-3 rounded-xl border-[1.5px] border-dashed text-center transition-colors ${
        over ? "border-primary bg-primary-tint" : "border-line-strong"
      } ${compact ? "px-4 py-3" : "px-6 py-7"}`}
    >
      <p className="text-muted-foreground">
        {compact
          ? "Drop more scans or your sample sheet here"
          : "Drop scans here: one file, a folder of them, and your sample sheet if you have one"}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" onClick={() => files.current?.click()}>
          <Upload className="size-4" aria-hidden />
          Choose files
        </Button>
        <Button size="sm" onClick={() => folder.current?.click()}>
          <FolderOpen className="size-4" aria-hidden />
          Choose a folder
        </Button>
      </div>
      {unreadable && (
        <p role="alert" className="text-ui text-destructive">
          Couldn't read what was dropped. Try Choose a folder instead.
        </p>
      )}
      <input
        ref={files}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={folder}
        type="file"
        className="hidden"
        // React has no typed prop for these; they make the picker choose a folder.
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
    </section>
  );
}

function SheetLine({
  sheet,
  matched,
  total,
  onRemove,
}: {
  sheet: SheetState;
  matched: number;
  total: number;
  onRemove: () => void;
}) {
  if (sheet.kind === "none") return null;
  if (sheet.kind === "reading") return <LoadingState rows={1} label={`Reading ${sheet.name}`} />;
  if (sheet.kind === "error")
    return (
      <p role="alert" className="text-ui text-destructive">
        Couldn't read {sheet.name}. Save it as CSV and drop it again.
      </p>
    );
  if (!sheetRecognised(sheet.sheet))
    return (
      <p role="alert" className="text-ui">
        Sample sheet <span className="font-medium">{sheet.sheet.name}</span>
        <span className="text-destructive">
          : no columns recognised. Its first row needs headers such as Mouse, Knee and Group.
        </span>{" "}
        <Button variant="link" onClick={onRemove}>
          Remove
        </Button>
      </p>
    );
  return (
    <p className="text-ui">
      Sample sheet <span className="font-medium">{sheet.sheet.name}</span>
      <span className="text-muted-foreground">
        {total > 0 && `, groups for ${matched} of ${total} ${total === 1 ? "scan" : "scans"}`}
      </span>{" "}
      <Button variant="link" onClick={onRemove}>
        Remove
      </Button>
    </p>
  );
}

type TableRow = Row & { input?: Input; upload?: UploadState; sample: Sample };

function IntakeTable({
  rows,
  several,
  onEdit,
  onRemove,
  onRetry,
  progress,
}: {
  rows: TableRow[];
  several: boolean;
  onEdit: (id: string, edit: Partial<Sample>) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  progress: Progress;
}) {
  const groups = [...new Set(rows.map((r) => r.sample.group.trim()).filter(Boolean))];
  const listId = useId();
  const subjects = new Set(rows.map((r) => r.sample.subject.trim()).filter(Boolean));
  // Wide: one line per scan. Narrow: the file on its own line, its cells under it.
  const cols = several
    ? "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_minmax(0,1fr)_2rem] gap-x-1.5 max-[640px]:grid-cols-[minmax(0,1fr)_6.5rem_minmax(0,1fr)]"
    : "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_2rem] gap-x-1.5 max-[640px]:grid-cols-[minmax(0,1fr)_6.5rem]";
  return (
    <div className="grid gap-2">
      {several && (
        <p className="text-ui text-muted-foreground">
          {rows.length} scans
          {subjects.size > 0 && ` of ${subjects.size} ${subjects.size === 1 ? "mouse" : "mice"}`}
        </p>
      )}
      <div className="rounded-lg border border-border">
        <div
          aria-hidden
          className={`${cols} border-b border-border px-3 py-2 text-meta font-medium text-fg-subtle max-[640px]:hidden`}
        >
          <span>File</span>
          <span className="px-2">Mouse</span>
          <span className="px-2">Knee</span>
          {several && <span className="px-2">Group</span>}
        </div>
        <ul>
          {rows.map((r) => {
            const ask = (v: string) => several && !v.trim();
            const cell = (v: string) =>
              `h-8 w-full min-w-0 rounded-md border px-2 outline-none focus-visible:border-ring ${
                ask(v)
                  ? "border-check-line bg-check-tint placeholder:text-check"
                  : "border-transparent bg-transparent hover:border-border max-[640px]:border-border"
              }`;
            const label = (text: string) => (
              <span className="text-meta text-fg-subtle min-[641px]:sr-only">{text}</span>
            );
            return (
              <li
                key={r.id}
                className={`${cols} items-start border-b border-line-subtle px-3 py-2 last:border-b-0 max-[640px]:gap-y-2`}
              >
                <div className="min-w-0 py-1.5 max-[640px]:col-span-full max-[640px]:col-start-1 max-[640px]:row-start-1 max-[640px]:pr-9">
                  <p className="truncate font-mono text-ui" title={r.name}>
                    {r.name}
                  </p>
                  <UploadLine
                    id={r.id}
                    upload={r.upload}
                    files={r.files}
                    progress={progress}
                    onRetry={() => onRetry(r.id)}
                  />
                </div>
                <label className="grid min-w-0 gap-0.5">
                  {label("Mouse")}
                  <input
                    aria-label={`Mouse for ${r.name}`}
                    value={r.sample.subject}
                    placeholder={several ? "Fill in" : "Optional"}
                    maxLength={200}
                    onChange={(e) => onEdit(r.id, { subject: e.target.value })}
                    className={cell(r.sample.subject)}
                  />
                </label>
                <label className="grid min-w-0 gap-0.5">
                  {label("Knee")}
                  <select
                    aria-label={`Knee for ${r.name}`}
                    value={r.sample.knee}
                    onChange={(e) => onEdit(r.id, { knee: e.target.value as Knee | "" })}
                    className={cell(r.sample.knee)}
                  >
                    <option value="">{several ? "Fill in" : "Optional"}</option>
                    <option>Right</option>
                    <option>Left</option>
                  </select>
                </label>
                {several && (
                  <label className="grid min-w-0 gap-0.5">
                    {label("Group")}
                    <input
                      aria-label={`Group for ${r.name}`}
                      value={r.sample.group}
                      list={listId}
                      placeholder="Fill in"
                      maxLength={200}
                      onChange={(e) => onEdit(r.id, { group: e.target.value })}
                      className={cell(r.sample.group)}
                    />
                  </label>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${r.name}`}
                  onClick={() => onRemove(r.id)}
                  className="grid size-8 place-items-center rounded-md text-fg-subtle hover:bg-accent hover:text-foreground max-[640px]:col-end-[-1] max-[640px]:row-start-1 max-[640px]:justify-self-end"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
        <datalist id={listId}>
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

function UploadLine({
  id,
  upload,
  files,
  progress,
  onRetry,
}: {
  id: string;
  upload: UploadState | undefined;
  files: Row["files"];
  progress: Progress;
  onRetry: () => void;
}) {
  const size =
    files &&
    `${files.count === 1 ? "1 file" : `${files.count} files`}, ${formatBytes(files.bytes)}`;
  if (!upload) return <p className="text-meta text-muted-foreground">Uploaded before</p>;
  switch (upload.kind) {
    case "waiting":
      return <p className="text-meta text-muted-foreground">{size}, waiting to upload</p>;
    case "uploading":
      return <UploadBar progress={progress} id={id} total={upload.total} />;
    case "finishing":
      return <p className="text-meta text-muted-foreground">Finishing the upload…</p>;
    case "ready":
      return <p className="text-meta text-primary-text">{size}, uploaded</p>;
    case "failed":
      return (
        <p className="text-meta text-destructive">
          {upload.paths.length === 1 ? "1 file" : `${upload.paths.length} files`} didn't upload.{" "}
          <Button variant="link" onClick={onRetry}>
            Retry
          </Button>
        </p>
      );
    case "error":
      return (
        <p className="max-w-80 text-meta text-destructive">
          {upload.message}{" "}
          {upload.retry && (
            <Button variant="link" onClick={onRetry}>
              Retry
            </Button>
          )}
        </p>
      );
  }
}

/** The one part of the page that re-renders as bytes go out. */
function UploadBar({ progress, id, total }: { progress: Progress; id: string; total: number }) {
  const sent = useSent(progress, id);
  const percent = total > 0 ? Math.floor((sent / total) * 100) : 0;
  return (
    <div className="mt-1 grid max-w-64 gap-1">
      <span
        role="progressbar"
        aria-label="Upload progress"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="block h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <span
          className="block h-full bg-info transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="text-meta text-muted-foreground tabular-nums">
        Uploading, {formatBytes(sent)} of {formatBytes(total)}
      </span>
    </div>
  );
}

function Earlier({
  inputs,
  open,
  chosen,
  hidden,
  onToggle,
}: {
  inputs: ReturnType<typeof useQuery<Input[]>>;
  open: boolean;
  chosen: Set<string>;
  /** Scans uploaded on this page, already in the table. */
  hidden: Set<string>;
  onToggle: (input: Input, on: boolean) => void;
}) {
  const list = inputs.data?.filter((i) => !hidden.has(i.id));
  return (
    // Opens again whenever uploading becomes impossible (`open`), as the page's way in.
    <Disclosure
      key={String(open)}
      defaultOpen={open}
      label={`Or use a scan you uploaded before${list ? ` (${list.length})` : ""}`}
    >
      <div>
        {inputs.isPending && <LoadingState rows={2} density="compact" label="Loading your scans" />}
        {inputs.isError && (
          <ErrorState title="Couldn't load your scans" onRetry={() => void inputs.refetch()} />
        )}
        {list?.length === 0 && <EmptyState title="No earlier scans" />}
        <ul className="grid">
          {list?.map((input) => (
            <li key={input.id} className="border-t border-line-subtle first:border-t-0">
              <label className="flex cursor-pointer items-center gap-3 py-2">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={chosen.has(input.id)}
                  onChange={(e) => onToggle(input, e.target.checked)}
                />
                <span className="min-w-0 flex-1 truncate">{input.name}</span>
                {input.source === "reference" && (
                  <span className="text-meta text-fg-subtle">Reference scan</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Disclosure>
  );
}
