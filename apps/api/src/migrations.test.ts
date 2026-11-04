// Guards the migration journal: drizzle applies migrations in `when` order, so a `when` at or below
// an earlier entry's (two PRs generating at once) silently skips or misorders a migration.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("migration journal `when` values strictly increase with idx", () => {
  const journal = JSON.parse(
    readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: { idx: number; when: number; tag: string }[] };
  let previous = Number.NEGATIVE_INFINITY;
  journal.entries.forEach((entry, i) => {
    expect(entry.idx, entry.tag).toBe(i);
    expect(entry.when, entry.tag).toBeGreaterThan(previous);
    previous = entry.when;
  });
});
