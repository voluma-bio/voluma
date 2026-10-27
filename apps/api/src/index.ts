/**
 * Voluma API, a Cloudflare Worker. A thin shell: the supervisor, thread
 * store, MCP server and R2 access live behind interfaces and are wired here
 * at the composition root as the run lane builds them.
 */
export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;
