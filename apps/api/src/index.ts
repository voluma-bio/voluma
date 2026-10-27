/**
 * Voluma API, a Cloudflare Worker and the composition root. It wires adapters
 * to the ports and mounts each lane's domain; the domains hold the logic.
 */
import type { DomainHandler } from "./domain";
import { handleReview } from "./domains/review";
import { handleRun } from "./domains/run";

const DOMAINS: DomainHandler[] = [handleRun, handleReview];

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");
    for (const handle of DOMAINS) {
      const response = await handle(request);
      if (response) return response;
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;
