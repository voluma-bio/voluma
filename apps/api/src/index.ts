/**
 * Voluma API, a Cloudflare Worker and the composition root: the only place
 * that reads env, builds adapters from its bindings, and hands each domain
 * its ports. Each domain owns every path under its prefix.
 */

import { d1EventLog, d1History } from "./adapters";
import type { DomainHandler } from "./domain";
import { createReview } from "./domains/review";
import { createRun } from "./domains/run";

interface Env {
  DB: D1Database;
  API_TOKEN: string;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");
    const mounts: [prefix: string, handler: DomainHandler][] = [
      [
        "/run/",
        createRun({
          eventLog: d1EventLog(env.DB),
          history: d1History(env.DB),
          apiToken: env.API_TOKEN,
        }),
      ],
      ["/review/", createReview({})],
    ];
    const mount = mounts.find(([prefix]) => pathname.startsWith(prefix));
    const response = mount ? await mount[1](request, ctx) : null;
    return response ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
