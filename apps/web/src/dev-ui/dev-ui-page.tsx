/**
 * /dev/ui: every shared component and every colour token, in the light and
 * the dark theme side by side. Check a component change here in both themes
 * before taking it into a screen. Sample content mirrors the OA6-1RK run.
 */
import {
  Button,
  Card,
  ChatComposer,
  ChatMessage,
  ChatThread,
  Lightbox,
  SplitPanel,
  StatusBadge,
  type StatusTone,
  Table,
  type TableColumn,
} from "@voluma/ui";
import { type ReactNode, useState } from "react";

const THEMES = ["light", "dark"] as const;

const THEME_LABELS = { light: "Light theme", dark: "Dark theme" };

export function DevUiPage() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {THEMES.map((theme) => (
        <ThemeColumn key={theme} theme={theme} />
      ))}
    </div>
  );
}

function ThemeColumn({ theme }: { theme: (typeof THEMES)[number] }) {
  return (
    <div id={`theme-${theme}`} data-theme={theme} className="grid content-start gap-10 p-8">
      <header>
        <h1 className="text-2xl font-semibold">{THEME_LABELS[theme]}</h1>
        <p className="text-ui text-muted-foreground">
          {theme === "light" ? "Workflows and runs" : "Review imaging workspace"}
        </p>
      </header>
      <Section title="Button">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Run on 1 scan</Button>
          <Button>Copy workflow</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="primary" disabled>
            Running
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm">
            Accept
          </Button>
          <Button size="sm">Move endpoints</Button>
          <Button variant="ghost" size="sm">
            Edit boundary
          </Button>
        </div>
      </Section>
      <Section title="Status badge">
        <div className="flex flex-wrap gap-2">
          {BADGES.map(([tone, label]) => (
            <StatusBadge key={label} tone={tone}>
              {label}
            </StatusBadge>
          ))}
        </div>
      </Section>
      <Section title="Card">
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <p className="font-mono text-meta text-fg-subtle">Task 2</p>
            <p>Only the trabecular part of the tibial IIOC</p>
            <p className="mt-2 text-ui text-muted-foreground">BV/TV, Tb.Th, Tb.Sp, Tb.N</p>
          </Card>
          <Card interactive>
            <p className="font-semibold">Draft from a methods section</p>
            <p className="text-ui text-muted-foreground">Each drafted task cites its source.</p>
          </Card>
        </div>
      </Section>
      <Section title="Table">
        <Table
          label="Runs"
          columns={RUN_COLUMNS}
          rows={RUNS}
          rowKey={(run) => run.scan}
          onRowClick={() => {}}
        />
        <Table
          label="Runs"
          columns={RUN_COLUMNS}
          rows={[]}
          rowKey={(run) => run.scan}
          empty="No runs yet."
        />
      </Section>
      <Section title="Chat thread">
        <ChatDemo />
      </Section>
      <Section title="Lightbox">
        <LightboxDemo />
      </Section>
      <Section title="Split panel">
        <div className="h-48 overflow-hidden rounded-xl border border-border">
          <SplitPanel
            label="Resize task panel"
            defaultSize={180}
            minSize={100}
            minRestSize={100}
            first={<Pane>Tasks</Pane>}
            second={
              <SplitPanel
                direction="vertical"
                label="Resize views"
                defaultSize={96}
                minSize={40}
                minRestSize={40}
                first={
                  <Pane well edge="bottom">
                    3D view
                  </Pane>
                }
                second={<Pane well>Axial slice</Pane>}
              />
            }
          />
        </div>
      </Section>
      <Section title="Tokens">
        <Swatches names={tokenNames((s) => s.includes('[data-theme="light"]'))} />
        <h3 className="mt-2 text-meta font-medium text-fg-subtle">Viewer (same in both themes)</h3>
        <Swatches
          names={tokenNames((s) => s === ":root").filter((n) => !FONT_TOKENS.includes(n))}
        />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

const BADGES: Array<[StatusTone, string]> = [
  ["neutral", "Pending"],
  ["info", "Running"],
  ["primary", "Done"],
  ["check", "2 to check"],
  ["info", "Corrected"],
  ["destructive", "Failed"],
  ["neutral", "Stopped"],
];

type RunRow = { scan: string; workflow: string; status: [StatusTone, string]; finished: string };

const RUNS: RunRow[] = [
  {
    scan: "OA6-1RK",
    workflow: "Mouse OA v2",
    status: ["check", "2 to check"],
    finished: "24 Oct, 14:02",
  },
  {
    scan: "OA7-2LK",
    workflow: "Mouse OA v2",
    status: ["info", "Running"],
    finished: "",
  },
  {
    scan: "OA6-2LK",
    workflow: "Mouse OA v1",
    status: ["primary", "Reviewed"],
    finished: "21 Oct, 09:40",
  },
];

const RUN_COLUMNS: TableColumn<RunRow>[] = [
  { key: "scan", header: "Scan", cell: (run) => <b className="font-semibold">{run.scan}</b> },
  { key: "workflow", header: "Workflow", cell: (run) => run.workflow },
  {
    key: "status",
    header: "Status",
    cell: (run) => <StatusBadge tone={run.status[0]}>{run.status[1]}</StatusBadge>,
  },
  { key: "finished", header: "Finished", align: "end", cell: (run) => run.finished || "—" },
];

function ChatDemo() {
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  return (
    <div className="grid gap-4 rounded-xl border border-border bg-card p-4">
      <ChatThread>
        <ChatMessage from="agent" author="Agent">
          Femur length is 15.82 mm, 5.8% above the paper's first reader. The distal endpoint sits on
          the condyle tip; the reader may have measured to the notch.
        </ChatMessage>
        <ChatMessage from="user">Show me the distal endpoint on the coronal slice.</ChatMessage>
        {sent.map((text, index) => (
          <ChatMessage key={index} from="user">
            {text}
          </ChatMessage>
        ))}
      </ChatThread>
      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSubmit={(text) => {
          setSent((previous) => [...previous, text]);
          setDraft("");
        }}
        placeholder="Ask about this task or ask for a change"
        suggestions={["Why this endpoint?", "Compare with the second reader"]}
      />
    </div>
  );
}

function LightboxDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button onClick={() => setOpen(true)}>Open evidence</Button>
      <Lightbox
        open={open}
        onClose={() => setOpen(false)}
        caption="Femur length, coronal slice 412: endpoints on the condyle tip and the trochanter"
      >
        <div
          role="img"
          aria-label="Evidence placeholder"
          className="grid h-[60dvh] w-[min(900px,80dvw)] place-items-center bg-viewer-well font-mono text-viewer-chip-fg"
        >
          QC image
        </div>
      </Lightbox>
    </div>
  );
}

function Pane({
  children,
  well = false,
  edge,
}: {
  children: ReactNode;
  well?: boolean;
  /** Draws a line on that side so the split between two panes reads. */
  edge?: "bottom";
}) {
  return (
    <div
      className={[
        "grid h-full place-items-center text-meta",
        well
          ? "bg-viewer-well text-viewer-chip-fg"
          : "border-r border-border bg-card text-muted-foreground",
        edge === "bottom" ? "border-b border-border" : "",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

/** Custom property names declared by the rules `match` selects, read from the loaded stylesheets. */
function tokenNames(match: (selector: string) => boolean): string[] {
  const names = new Set<string>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule && match(rule.selectorText)) {
        for (const name of rule.style) if (name.startsWith("--")) names.add(name.slice(2));
      } else if (rule instanceof CSSGroupingRule) visit(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) visit(sheet.cssRules);
  return [...names];
}

const FONT_TOKENS = ["sans", "mono"];

function Swatches({ names }: { names: string[] }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
      {names.map((name) => (
        <li key={name} className="flex items-center gap-2 text-meta text-muted-foreground">
          <span
            className="size-5 shrink-0 rounded-md border border-border"
            style={{ background: `var(--${name})` }}
          />
          <code className="font-mono">--{name}</code>
        </li>
      ))}
    </ul>
  );
}
