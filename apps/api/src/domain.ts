/**
 * The contract between the composition root and each domain. A domain is
 * built by a factory that takes its own dependencies (ports, never env or
 * concrete adapters). index.ts mounts it at a path prefix and calls the handler
 * with the path relative to that mount (`/ingest/...`), so a domain does not know
 * where it is mounted. Returning null means no route matched.
 */
export type DomainHandler = (
  request: Request,
  path: string,
) => Promise<Response | null> | Response | null;
