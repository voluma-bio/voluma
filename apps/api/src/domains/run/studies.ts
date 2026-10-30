/**
 * The browser's study routes (`@voluma/contracts/study`): create (a study, its scans and the
 * runs to start now, in one transaction), list and get. Reads take `requireReader`, create
 * takes `requireUser`; the queue holds visitor keys, so no handler logs a body.
 */
import { randomUUID } from "node:crypto";
import { createStudyRequestSchema } from "@voluma/contracts/study";
import { Hono } from "hono";
import {
  type AppEnv,
  callerOf,
  parseJson,
  readerOf,
  requireReader,
  requireUser,
} from "../../domain";
import type { RunDeps } from ".";

export function studiesRoutes({ studies, queue }: RunDeps) {
  const app = new Hono<AppEnv>();

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
      scans: body.scans.map(({ inputId, subject, group, attributes }) => ({
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
      },
    });
    const detail = await studies.get(reader, result.studyId);
    if (!detail) throw new Error(`study ${result.studyId} vanished after it was created`);
    return c.json(detail);
  });

  app.get("/studies", requireReader, async (c) =>
    c.json({ studies: await studies.list(c.var.reader) }),
  );

  app.get("/studies/:id", requireReader, async (c) => {
    const study = await studies.get(c.var.reader, c.req.param("id"));
    return study ? c.json(study) : c.json({ error: "not found" }, 404);
  });

  return app;
}
