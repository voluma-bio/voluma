/**
 * A worker sandbox's way to providers: the gateway's URL and a token for that sandbox.
 * `sandbox` is the name the runner writes in the sandbox's `sandbox` event, which the run page
 * attributes spend by. The token goes on the run's redact list, since the agent can read it
 * from the sandbox's environment.
 *
 * Until the gateway lands (its token is minted per sandbox), the token is `VOLUMA_GATEWAY_TOKEN`
 * from the environment, the same for every sandbox: enough to drive a stub gateway.
 */
import type { Config } from "./config.ts";
import type { Redact } from "./redact.ts";

export function sandboxGateway(
  config: Config,
  _claim: { runId: string; leaseToken: string; visitorMetaKey?: string },
  _sandbox: string,
  redact: Redact,
): { url: string; token: string } | undefined {
  const { gateway } = config;
  if (!gateway) return undefined;
  const token = process.env.VOLUMA_GATEWAY_TOKEN;
  if (!token) throw new Error("set VOLUMA_GATEWAY_TOKEN: no gateway token is minted yet");
  redact.add(token);
  return { url: gateway.url, token };
}
