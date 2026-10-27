/**
 * The contract between the composition root and each domain. A domain is
 * built by a factory that takes its own dependencies (ports, never env or
 * concrete adapters), and the handler it returns answers the requests under
 * the path prefix index.ts mounts it at.
 */
export type DomainHandler = (
  request: Request,
  ctx: ExecutionContext,
) => Promise<Response | null> | Response | null;
