/**
 * A worker sandbox's way to providers: the gateway's URL and a token minted for that sandbox.
 * `sandbox` is the name the runner writes in the sandbox's `sandbox` event, which the run page
 * attributes spend by. The token is scoped to the providers a sandbox tool uses: Meta
 * (`segment_sam`) and the plate model (`segment_plate`, always on our key); a starter's own Meta
 * key rides inside it. It goes on the run's redact list, since the agent can
 * read it from the sandbox's environment.
 */
import { mintGatewayToken } from "@voluma/provider-calls/token";
import type { Config } from "./config.ts";
import type { Redact } from "./redact.ts";

export function sandboxGateway(
  config: Config,
  claim: { runId: string; leaseToken: string; ownMetaKey?: string },
  sandbox: string,
  redact: Redact,
): { url: string; token: string; ipv4?: string } | undefined {
  const { gateway } = config;
  const secret = gateway?.secrets[0];
  if (!gateway || !secret) return undefined;
  const token = mintGatewayToken(
    {
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      sandbox,
      providers: ["meta", "plate"],
      lifetimeSeconds: config.sandbox.lifetimeSeconds,
      ...(claim.ownMetaKey && { ownKeys: { meta: claim.ownMetaKey } }),
    },
    secret,
  );
  redact.add(token);
  return { url: gateway.url, token, ipv4: gateway.ipv4 };
}
