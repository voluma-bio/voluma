/**
 * The input review's Study panel: the study's inputs, this one marked, each opening its newest run,
 * and a link to the study overview when there is more than one input. The page polls the study
 * (`study`) while any of its runs goes.
 */
import type { UseQueryResult } from "@tanstack/react-query";
import type { Run } from "@voluma/contracts/run";
import type { StudyDetail } from "@voluma/contracts/study";
import { inputHref, plural, StudyPanel } from "@voluma/run-view";
import { Button, ErrorState, INPUT_WORD, LoadingState, ShellPanel } from "@voluma/ui";
import { workflowById } from "@voluma/workflow/bundled";
import { ArrowUpRight, PanelLeft } from "lucide-react";
import { Link, useSearchParams } from "react-router";

export function StudyDock({ run, study }: { run: Run; study: UseQueryResult<StudyDetail> }) {
  const [params] = useSearchParams();
  return (
    <ShellPanel
      id="input-study"
      side="left"
      group="study"
      label="Study"
      icon={<PanelLeft />}
      shortcut="s"
    >
      {study.data ? (
        <>
          {study.isError && (
            <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
              Couldn't refresh the study; what you see may be out of date.
              <Button variant="link" onClick={() => void study.refetch()}>
                Try again
              </Button>
            </p>
          )}
          {study.data.inputs.length > 1 && (
            <div className="border-b border-border px-4 py-2">
              <Button asChild variant="link">
                <Link to={`/studies/${study.data.study.id}`}>
                  Study overview <ArrowUpRight className="size-3.5" />
                </Link>
              </Button>
            </div>
          )}
          <StudyPanel
            detail={study.data}
            about={`${plural(study.data.inputs.length, INPUT_WORD.one, INPUT_WORD.many)}, ${workflowById(study.data.study.workflowId)?.name ?? study.data.study.workflowId}`}
            current={run.input.id}
            inputLink={({ member, runs }) =>
              runs.length > 0
                ? (props) => (
                    <Link
                      // The open input keeps what it shows (its run and selection); another opens its newest run.
                      to={
                        member.inputId === run.input.id
                          ? { search: params.toString() }
                          : inputHref(run.studyId, member.inputId)
                      }
                      {...props}
                    />
                  )
                : undefined
            }
          />
        </>
      ) : study.isPending ? (
        <LoadingState label="Loading the study" rows={3} className="p-4" />
      ) : (
        <div className="p-4">
          <ErrorState title="Couldn't load the study" onRetry={() => void study.refetch()}>
            Check your connection, then try again.
          </ErrorState>
        </div>
      )}
    </ShellPanel>
  );
}
