/**
 * PR-body check: a PR body must carry every `##` section of
 * .github/PULL_REQUEST_TEMPLATE.md, each with something the template didn't
 * ship. The headings are read from the template, so editing the template
 * updates the check. Three more rules:
 *   - Changelog lines start "- Added:", "- Changed:", "- Fixed:" or
 *     "- Removed:", or the section is one line "None. <reason>".
 *   - A PR touching UI sources shows a screenshot or says "No visual change".
 *   - A PR touching packages/contracts can't write "None." under Contract changes.
 * Structure is checked here; whether the text is true is the reviewer's job.
 *
 * Usage:
 *   pnpm check:pr-body <body.md>
 *       Local draft. Changed files come from git: everything that differs
 *       from the merge base with origin/main, committed or not.
 *   PR_BODY=<body> node tools/ci/check-pr-body.mjs --changed-files <list.txt>
 *       CI. The body arrives in an env var so untrusted markdown never
 *       reaches the shell.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE_PATH = resolve(ROOT, ".github/PULL_REQUEST_TEMPLATE.md");

const CHANGELOG = "## Changelog";
const CONTRACTS = "## Contract changes";
const CHANGELOG_ENTRY = /^- (Added|Changed|Fixed|Removed): (\S.*)$/;
const NONE_WITH_REASON = /^None\.\s+\S/;
const PLACEHOLDER = /^<.*>$/;

const UI_PATH = /^(apps\/web\/src\/|packages\/(ui|viewer|design-tokens)\/)/;
const CONTRACTS_PATH = /^packages\/contracts\//;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const IMAGE = /!\[[^\]]*\](?:\([^)]+\)|\[[^\]]+\])|<img\s/;
const NO_VISUAL_CHANGE = /no visual change/i;

const { bodyPath, changedFilesPath } = parseArgs(process.argv.slice(2));
// pnpm runs scripts from the repo root; INIT_CWD is where the user typed the command.
const body =
  process.env.PR_BODY ?? readFileSync(resolve(process.env.INIT_CWD ?? ".", bodyPath), "utf8");
const changedFiles = changedFilesPath
  ? readFileSync(changedFilesPath, "utf8").split("\n")
  : changedFilesFromGit();
const changed = changedFiles.map((file) => file.trim()).filter(Boolean);

const template = readFileSync(TEMPLATE_PATH, "utf8");
const headings = template
  .split("\n")
  .filter((line) => line.startsWith("## "))
  .map((line) => line.trim());
// Every template line outside comments: a body line counts only if it isn't one of these.
const scaffoldLines = new Set(authoredLines(template));
const sections = scanSections(body);
const failures = [];

for (const heading of headings) {
  const content = sections.get(heading);
  if (content === undefined) {
    failures.push(`missing section: ${heading}`);
    continue;
  }
  if (heading === CHANGELOG) {
    const problem = changelogProblem(authoredLines(content));
    if (problem) failures.push(`${CHANGELOG}: ${problem}`);
  } else if (!authoredLines(content).some((line) => !scaffoldLines.has(line))) {
    failures.push(`section says nothing beyond the template: ${heading}`);
  }
}

// Comments are stripped first: the template's own guidance mentions "No visual change".
const visibleBody = stripComments(body);
if (changed.some((file) => UI_PATH.test(file) && !TEST_FILE.test(file))) {
  if (!IMAGE.test(visibleBody) && !NO_VISUAL_CHANGE.test(visibleBody)) {
    failures.push(
      'UI files changed: add a screenshot under Verification, or write "No visual change" and why',
    );
  }
}

if (changed.some((file) => CONTRACTS_PATH.test(file))) {
  const [first] = authoredLines(sections.get(CONTRACTS) ?? "");
  if (first && /^None\b/i.test(first)) {
    failures.push(
      `packages/contracts changed, so ${CONTRACTS} can't be "None.": say what changed and which callers it moved`,
    );
  }
}

if (failures.length > 0) {
  console.error("PR body does not follow .github/PULL_REQUEST_TEMPLATE.md:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\n`gh pr create --body-file` skips GitHub's template: copy every ## section into the body file.",
  );
  process.exit(1);
}
console.log(`PR body carries all ${headings.length} template sections.`);

function parseArgs(args) {
  let bodyPath;
  let changedFilesPath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--changed-files") changedFilesPath = args[++index];
    else bodyPath = args[index];
  }
  if (!changedFilesPath && !bodyPath) {
    console.error("usage: pnpm check:pr-body <body.md>");
    console.error(
      "   or: PR_BODY=<body> node tools/ci/check-pr-body.mjs --changed-files <list.txt>",
    );
    process.exit(2);
  }
  if (process.env.PR_BODY === undefined && !bodyPath) {
    console.error("no body: pass <body.md> or set PR_BODY");
    process.exit(2);
  }
  return { bodyPath, changedFilesPath };
}

function changedFilesFromGit() {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
  try {
    const base = git("merge-base", "origin/main", "HEAD").trim();
    return [
      ...git("diff", "--name-only", base).split("\n"),
      ...git("ls-files", "--others", "--exclude-standard").split("\n"),
    ];
  } catch (error) {
    console.error(`could not list changed files from git (${error.message.split("\n")[0]})`);
    console.error("run `git fetch origin`, or pass --changed-files <list.txt>");
    process.exit(2);
  }
}

function stripComments(markdown) {
  return markdown.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
}

/** Non-empty trimmed lines with HTML comments removed. */
function authoredLines(markdown) {
  return stripComments(markdown)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Text under each `##` heading. Headings inside fenced code blocks don't
 * count, so a body can quote the template. A repeated heading keeps its first section.
 */
function scanSections(markdown) {
  const found = new Map();
  let fence = null;
  let current = null;
  for (const line of stripComments(markdown).split("\n")) {
    if (fence) {
      if (new RegExp(`^ {0,3}\\${fence.char}{${fence.length},}\\s*$`).test(line)) fence = null;
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (opening) {
        fence = { char: opening[1][0], length: opening[1].length };
      } else if (line.trim().startsWith("## ")) {
        const heading = line.trim();
        current = [];
        if (!found.has(heading)) found.set(heading, current);
        continue;
      }
    }
    current?.push(line);
  }
  return new Map([...found].map(([heading, lines]) => [heading, lines.join("\n")]));
}

function changelogProblem(lines) {
  if (lines.length === 0)
    return 'write one line per change starting "- Added:" etc., or "None. <reason>"';
  if (lines[0].startsWith("None.")) {
    if (!NONE_WITH_REASON.test(lines[0])) return '"None." needs a reason on the same line';
    if (lines.length > 1) return '"None. <reason>" must be the only line';
    return null;
  }
  for (const line of lines) {
    const entry = CHANGELOG_ENTRY.exec(line);
    if (!entry) return `"${line}" does not start with - Added:, - Changed:, - Fixed: or - Removed:`;
    if (PLACEHOLDER.test(entry[2])) return "replace the template placeholder with what changed";
  }
  return null;
}
