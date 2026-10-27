/**
 * Voluma API, a Cloudflare Worker and the composition root: the only place
 * that reads env, builds adapters from its bindings, and hands each domain
 * its ports. Each domain owns every path under its prefix.
 */
import type { DomainHandler } from "./domain";
import { createReview } from "./domains/review";
import { createRun } from "./domains/run";

// Bindings (R2, D1, the sandbox) arrive with the first domain that needs each
// one; generate this type with `wrangler types` once there are any.
type Env = Record<string, never>;

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
