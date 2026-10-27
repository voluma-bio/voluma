/**
 * Voluma API, a Cloudflare Worker and the composition root: the only place
 * that reads env, builds adapters from its bindings, and hands each domain
 * its ports. Each domain owns every path under its prefix.
 */

import type { RunSandbox, RunSandboxEnv } from "./adapters";
import type { DomainHandler } from "./domain";
import { createReview } from "./domains/review";
import { createRun } from "./domains/run";

export { S3Gateway } from "@cloudflare/sandbox";
// Durable Object classes and entrypoints are exported from the main module for Wrangler.
export { RunSandbox } from "./adapters";

interface Env extends RunSandboxEnv {
  RUN_SANDBOX: DurableObjectNamespace<RunSandbox>;
  DB: D1Database;
  API_TOKEN: string;
}

export default {
  async fetch(request, _env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");
    const mounts: [prefix: string, handler: DomainHandler][] = [
      ["/run/", createRun({})],
      ["/review/", createReview({})],
    ];
    const mount = mounts.find(([prefix]) => pathname.startsWith(prefix));
    const response = mount ? await mount[1](request, ctx) : null;
    return response ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
