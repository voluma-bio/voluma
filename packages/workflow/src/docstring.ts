/**
 * The first line of a Python module's docstring, read with a regex (no Python run): the one-line
 * index sentence `workflows/core/AGENTS.md` requires of every skill script, which the tool index
 * in the agents' prompts shows.
 */
import { WorkflowParseError } from "./definition";

// Comment lines (a shebang, an encoding line) may precede the docstring; it may start on the line
// after its opening quotes.
const DOCSTRING = /^(?:[ \t]*#[^\n]*\n|[ \t]*\n)*[ \t]*[rRuU]?(?:"""|''')\s*([^\n]*)/;

export function docstringSummary(path: string, source: string): string {
  const line = DOCSTRING.exec(source)?.[1]
    ?.replace(/\s*(?:"""|''')\s*$/, "")
    .trim();
  if (!line) throw new WorkflowParseError(path, "the script has no module docstring");
  return line;
}
