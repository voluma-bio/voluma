/**
 * The Samples tree (on screen, `INPUT_WORD.Many`): the studies, each one's samples grouped Needs
 * you, Running and Done, and a search above them. A researcher jumps between samples with it
 * without leaving review: the study pages show it on the left, and the scan page's left side is
 * meant to show the same tree as a tab. Which branches are open is kept across pages
 * and visits; while a search is typed every branch with a match is open. Keys follow the ARIA
 * tree: Up and Down move, Left and Right close and open, Enter opens a sample, Home and End.
 * A row's look is a status glyph, the sample's name and one short line: no dividers.
 */
import { ChevronRight, Search } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { cx } from "./cx";
import { STATUS_WORD, type Status, StatusGlyph } from "./status-mark";
import { INPUT_WORD } from "./words";

export type SampleGroup = "needs-you" | "running" | "done";

export type TreeSample = {
  id: string;
  /** What people call it, e.g. "OA6-1RK". */
  name: string;
  /** One short line after the name: what it needs, or its group and knee. */
  meta?: string;
  status: Status;
  group: SampleGroup;
  /** Where it opens. */
  href: string;
};

export type TreeStudy = {
  id: string;
  name: string;
  samples: TreeSample[];
};

/** Props to spread on your router's link: they carry the row's look, focus and tree role. */
export type TreeLinkProps = {
  className: string;
  children: ReactNode;
  role: "treeitem";
  tabIndex: number;
  "aria-level": number;
  "aria-current"?: "page";
  title: string;
  "data-key": string;
};

export type SampleTreeProps = {
  studies: TreeStudy[];
  /** The study this page belongs to: open unless closed by hand. */
  studyId?: string;
  /** The sample whose page is open: highlighted. */
  sampleId?: string;
  /** Your router's link; a plain `<a>` without it. */
  renderLink?: (href: string, props: TreeLinkProps) => ReactNode;
};

const GROUPS: [SampleGroup, string][] = [
  ["needs-you", "Needs you"],
  ["running", "Running"],
  ["done", "Done"],
];
const STORAGE_KEY = "voluma.samples-open";

type TreeRow =
  | { key: string; level: 1; kind: "study"; name: string; count: number; open: boolean }
  | {
      key: string;
      level: 2;
      kind: "group";
      name: string;
      count: number;
      open: boolean;
      parent: string;
    }
  | { key: string; level: 3; kind: "sample"; sample: TreeSample; current: boolean; parent: string };

function loadOpen(): Record<string, boolean> {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

const squash = (s: string) => s.toLowerCase().replace(/[-\s_]/g, "");

export function SampleTree({ studies, studyId, sampleId, renderLink }: SampleTreeProps) {
  const [query, setQuery] = useState("");
  const [openKeys, setOpenKeys] = useState(loadOpen);
  const [focusKey, setFocusKey] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const here = studyId ?? studies[0]?.id;

  const rows = useMemo(() => {
    const q = squash(query.trim());
    const isOpen = (key: string, initial: boolean) => (q ? true : (openKeys[key] ?? initial));
    const out: TreeRow[] = [];
    for (const study of studies) {
      const hits = study.samples.filter((s) => !q || squash(s.name).includes(q));
      if (q && !hits.length) continue;
      const key = `study:${study.id}`;
      const open = isOpen(key, study.id === here);
      out.push({
        key,
        level: 1,
        kind: "study",
        name: study.name,
        count: study.samples.length,
        open,
      });
      if (!open) continue;
      for (const [group, name] of GROUPS) {
        const inGroup = hits.filter((s) => s.group === group);
        if (!inGroup.length) continue;
        const gkey = `${key}|${group}`;
        const gopen = isOpen(gkey, true);
        out.push({
          key: gkey,
          level: 2,
          kind: "group",
          name,
          count: study.samples.filter((s) => s.group === group).length,
          open: gopen,
          parent: key,
        });
        if (gopen)
          for (const sample of inGroup)
            out.push({
              key: `${key}|${sample.id}`,
              level: 3,
              kind: "sample",
              sample,
              current: study.id === here && sample.id === sampleId,
              parent: gkey,
            });
      }
    }
    return out;
  }, [studies, query, openKeys, here, sampleId]);

  const focused =
    rows.find((r) => r.key === focusKey) ??
    rows.find((r) => r.kind === "sample" && r.current) ??
    rows[0];

  const setOpen = (key: string, open: boolean) => {
    const next = { ...openKeys, [key]: open };
    setOpenKeys(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Disabled or full storage: the tree still opens and closes, just not across visits.
    }
  };
  const focusRow = (key: string) => {
    setFocusKey(key);
    list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const i = rows.findIndex((r) => r.key === focused?.key);
    const row = rows[i];
    if (!row) return;
    const branch = row.kind !== "sample";
    const next = rows[i + 1];
    const prev = rows[i - 1];
    const go = (r: TreeRow | undefined) => r && focusRow(r.key);
    switch (event.key) {
      case "ArrowDown":
        go(next);
        break;
      case "ArrowUp":
        if (prev) go(prev);
        else input.current?.focus();
        break;
      case "ArrowRight":
        if (branch && !row.open) setOpen(row.key, true);
        else if (branch) go(next);
        break;
      case "ArrowLeft":
        if (branch && row.open) setOpen(row.key, false);
        else if (row.kind !== "study") focusRow(row.parent);
        break;
      case "Home":
        go(rows[0]);
        break;
      case "End":
        go(rows.at(-1));
        break;
      case "Enter":
      case " ":
        // A sample is a link: Enter follows it.
        if (!branch) return;
        setOpen(row.key, !row.open);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className="flex flex-col">
      <label className="relative mx-2 mt-2 mb-1 block">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-subtle"
        />
        <input
          ref={input}
          type="search"
          value={query}
          placeholder={`Find a ${INPUT_WORD.one}`}
          aria-label={`Find a ${INPUT_WORD.one}`}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && rows[0]) {
              e.preventDefault();
              focusRow(rows[0].key);
            }
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          className="h-7 w-full rounded-md border border-input bg-card pr-2 pl-7 text-base text-foreground placeholder:text-fg-subtle focus:border-transparent focus:outline-2 focus:outline-ring focus:-outline-offset-1"
        />
      </label>
      {rows.length ? (
        <div
          ref={list}
          role="tree"
          aria-label={INPUT_WORD.Many}
          onKeyDown={onKeyDown}
          className="pt-0.5 pb-3"
        >
          {rows.map((row) => (
            <Row
              key={row.key}
              row={row}
              focusable={row.key === focused?.key}
              onFocus={() => setFocusKey(row.key)}
              onToggle={() => row.kind !== "sample" && setOpen(row.key, !row.open)}
              renderLink={renderLink}
            />
          ))}
        </div>
      ) : (
        <p className="m-0 px-3.5 py-2 text-muted-foreground text-sm">
          {query ? `No ${INPUT_WORD.one} matches “${query.trim()}”` : `No ${INPUT_WORD.many} yet`}
        </p>
      )}
    </div>
  );
}

const rowClass =
  "flex h-7 cursor-pointer items-center gap-1.5 pr-2.5 text-base text-foreground whitespace-nowrap outline-none hover:bg-accent focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]";
const indent = { 1: "pl-1.5", 2: "pl-5", 3: "pl-9" } as const;

function Row({
  row,
  focusable,
  onFocus,
  onToggle,
  renderLink,
}: {
  row: TreeRow;
  focusable: boolean;
  onFocus(): void;
  onToggle(): void;
  renderLink?: SampleTreeProps["renderLink"];
}) {
  if (row.kind === "sample") {
    const { sample } = row;
    const props: TreeLinkProps = {
      role: "treeitem",
      tabIndex: focusable ? 0 : -1,
      "aria-level": 3,
      "aria-current": row.current ? "page" : undefined,
      title: `${sample.name}: ${STATUS_WORD[sample.status].toLowerCase()}`,
      "data-key": row.key,
      className: cx(rowClass, indent[3], "no-underline", row.current && "bg-select-tint"),
      children: (
        <>
          <StatusGlyph status={sample.status} />
          <span className="font-medium font-mono text-sm tabular-nums">{sample.name}</span>
          {sample.meta && (
            <span className="min-w-0 truncate text-fg-subtle text-xs">{sample.meta}</span>
          )}
        </>
      ),
    };
    return (
      <div role="none" onFocus={onFocus}>
        {renderLink ? renderLink(sample.href, props) : <a href={sample.href} {...props} />}
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tree's keys are handled on the tree, for every row
    <div
      role="treeitem"
      aria-level={row.level}
      aria-expanded={row.open}
      tabIndex={focusable ? 0 : -1}
      data-key={row.key}
      onFocus={(e) => e.target === e.currentTarget && onFocus()}
      onClick={onToggle}
      className={cx(rowClass, indent[row.level])}
    >
      <ChevronRight
        aria-hidden
        className={cx(
          "size-3.5 shrink-0 p-0.5 text-fg-subtle transition-transform motion-reduce:transition-none",
          row.open && "rotate-90",
        )}
      />
      <span
        className={cx(
          "min-w-0 truncate",
          row.kind === "study" ? "font-semibold" : "font-medium text-muted-foreground text-sm",
        )}
      >
        {row.name}
      </span>
      {row.kind === "study" && <span className="flex-1" />}
      <span className="text-fg-subtle text-xs">{row.count}</span>
    </div>
  );
}
