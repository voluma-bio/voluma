/**
 * The browser's study routes (`@voluma/contracts/study`): create (a study, its inputs and the
 * runs to start now, in one transaction), list and get. Reads take `requireReader`, create
 * takes `requireUser`; the queue holds visitor keys, so no handler logs a body.
 */
import { randomUUID } from "node:crypto";
import { createStudyRequestSchema } from "@voluma/contracts/study";
import { Hono } from "hono";
import {
  type AppEnv,
  callerOf,
  type Principal,
  parseJson,
  readerOf,
  requireReader,
  requireUser,
} from "../../domain";
import type { RunDeps } from ".";
import type { CanAnswer } from "./pg-studies";

export function studiesRoutes({ studies, queue }: RunDeps) {
  const app = new Hono<AppEnv>();

  /** Whether `principal` can answer a run's held calls: the run read's `cannotMessage` is null. The debug token only reads. */
  const canAnswerAs =
    (principal: Principal): CanAnswer =>
    async (tx, run, workflowId) =>
      principal.kind === "user" && (await queue.cannotMessage(run, tx, workflowId)) === null;

  app.post("/studies", requireUser, async (c) => {
    const body = await parseJson(c, createStudyRequestSchema);
    const user = c.var.user;
    const reader = readerOf(user);
    const result = await queue.createStudy(reader, callerOf(user), {
      study: {
        id: randomUUID(),
        name: body.name,
        workflowId: body.workflowId,
        budgetUsd: body.budgetUsd ?? null,
      },
      inputs: body.inputs.map(({ inputId, subject, group, attributes }) => ({
        inputId,
        subject,
        group: group ?? null,
        attributes: attributes ?? {},
      })),
      starts: {
        runs: body.start.map((inputId) => ({ id: randomUUID(), inputId })),
        selectedOutputs: body.selectedOutputs,
        notes: body.notes,
        keys: body.keys,
        model: body.model,
        thinking: body.thinking,
      },
    });
    const detail = await studies.get(reader, result.studyId, canAnswerAs(user));
    if (!detail) throw new Error(`study ${result.studyId} vanished after it was created`);
    return c.json(detail);
  });

  app.get("/studies", requireReader, async (c) =>
    c.json({ studies: await studies.list(c.var.reader, canAnswerAs(c.var.principal)) }),
  );

  app.get("/studies/:id", requireReader, async (c) => {
    const study = await studies.get(c.var.reader, c.req.param("id"), canAnswerAs(c.var.principal));
    return study ? c.json(study) : c.json({ error: "not found" }, 404);
  });

  return app;
}
