/**
 * The study's Details: what the study is (its groups and which scans are in each, the workflow,
 * the budget and what its runs have spent). Read-only: editing a study isn't built.
 */
import { formatUsd, groupNames, groupOf, kneeOf, plural } from "@voluma/run-view";
import { Button, Facts, PageHead } from "@voluma/ui";
import { Link } from "react-router";
import { useStudy } from "./study-layout";
import { studySpend } from "./study-model";

export function DetailsPage() {
  const { detail, workflow } = useStudy();
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  const groups = groupNames(detail).map((g) => {
    const scans = detail.scans.filter((s) => groupOf(s, grouped) === g);
    const knees = [...new Set(scans.map(kneeOf))];
    const knee = knees.length === 1 && knees[0] ? `, ${knees[0].toLowerCase()} knees` : "";
    const names = scans.map((s) => s.scan.subject);
    const range = names.length > 2 ? `${names[0]} to ${names.at(-1)}` : names.join(" and ");
    return `${grouped ? `${g}: ` : ""}${range}${knee}.`;
  });
  const spent = studySpend(detail);
  const budget = detail.study.budgetUsd;
  return (
    <>
      <PageHead title="Study details" />
      <Facts
        className="px-6 py-4 text-base"
        items={[
          [grouped ? "Groups" : "Scans", <span key="g">{groups.join(" ")}</span>],
          [
            "Workflow",
            <span key="w" className="flex flex-wrap items-baseline gap-x-2">
              {workflow.name}
              <Button asChild variant="link">
                <Link to="/workflows">See its {plural(workflow.tasks.length, "task")}</Link>
              </Button>
            </span>,
          ],
          [
            "Spent",
            <span key="s" className="font-mono">
              {formatUsd(spent)}
              {budget !== null && ` of ${formatUsd(budget)}`}
            </span>,
          ],
          ...(detail.study.example
            ? [["Example", "A shared example: you can look but not change it."] as [string, string]]
            : []),
        ]}
      />
    </>
  );
}
