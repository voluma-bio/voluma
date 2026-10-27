/**
 * The contract between the composition root and each domain. A domain
 * answers the requests it owns and returns null for the rest, so each lane
 * adds endpoints in its own domain without editing index.ts.
 */
export type DomainHandler = (request: Request) => Promise<Response | null> | Response | null;
