/** Enforce the repository template headings and meaningful content without executing PR text. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const template = readFileSync(".github/PULL_REQUEST_TEMPLATE.md", "utf8");
const body = (process.env.PR_BODY || "").replace(/<!--[\s\S]*?-->/g, "");
const headings = [...template.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
const sections = new Map(
  [...body.matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map(
    (match) => [match[1], match[2].trim()],
  ),
);
const errors = headings
  .filter(
    (heading) =>
      !sections.get(heading) ||
      /^(todo|tbd|n\/a|\.\.\.)$/i.test(sections.get(heading)),
  )
  .map((heading) => `Fill in the ${heading} section.`);
if (process.env.PR_BASE_SHA) {
  const files = execFileSync(
    "git",
    ["diff", "--name-only", `${process.env.PR_BASE_SHA}...HEAD`],
    { encoding: "utf8" },
  ).split("\n");
  const visual = sections.get("Visual evidence") || "";
  if (
    files.some((file) =>
      /^(apps\/app|packages\/(review|design-tokens))\//.test(file),
    ) &&
    !/!\[|https?:\/\/\S+\.(png|jpe?g|webp|mp4|webm)|github\.com\/user-attachments\/|No visual change/i.test(
      visual,
    )
  )
    errors.push(
      "Include visual evidence or explicitly state No visual change.",
    );
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log("PR body matches the template.");
