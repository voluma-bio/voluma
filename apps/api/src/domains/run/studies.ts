/**
 * The browser's study routes (`@voluma/contracts/study`): create (a study, its scans and the
 * runs to start now, in one transaction), list and get. Reads take `requireReader`, create
 * takes `requireUser`; the queue holds visitor keys, so no handler logs a body.
 */
import { randomUUID } from "node:crypto";
import { createStudyRequestSchema, studyOutputsQuerySchema } from "@voluma/contracts/study";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, parseJson, readerOf, requireReader, requireUser } from "../../domain";
import type { RunDeps } from ".";
import { pinsOf } from "./catalog";
import { refusal } from "./runs";

export function studiesRoutes({ reads, queue, catalog, repo }: RunDeps) {
  const app = new Hono<AppEnv>();

  app.post("/studies", requireUser, async (c) => {
    const body = await parseJson(c, createStudyRequestSchema);
    const pins = pinsOf(catalog, repo, body.workflowId);
    if (!pins) return c.json({ error: "unknown workflow" }, 404);
    const user = c.var.user;
    const reader = readerOf(user);
    const studyId = randomUUID();
    const result = await queue.createStudy(
      reader,
      { userId: user.userId },
      {
        study: {
          id: studyId,
          name: body.name,
          workflowId: body.workflowId,
          budgetUsd: body.budgetUsd ?? null,
        },
        pins,
        scans: body.scans.map(({ inputId, subject, group, attributes }) => ({
          inputId,
          subject,
          group: group ?? null,
          attributes: attributes ?? {},
        })),
        runs: body.start.map((inputId) => ({
          id: randomUUID(),
          inputId,
          selectedOutputs: body.selectedOutputs,
          notes: body.notes,
          keys: body.keys,
        })),
      },
    );
    if ("refused" in result) return refusal(c, result.refused);
    const detail = await reads.study(reader, result.studyId, []);
    return c.json(detail);
  });

  app.get("/studies", requireReader, async (c) =>
    c.json({ studies: await reads.studies(c.var.reader) }),
  );

  app.get("/studies/:id", requireReader, async (c) => {
    const query = c.req.query("outputs");
    const outputs = studyOutputsQuerySchema.safeParse(query ? query.split(",") : []);
    if (!outputs.success) throw new HTTPException(400, { message: outputs.error.message });
    const study = await reads.study(c.var.reader, c.req.param("id"), outputs.data);
    return study ? c.json(study) : c.json({ error: "not found" }, 404);
  });

  return app;
}
