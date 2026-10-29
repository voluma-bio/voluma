/**
 * `voluma-sam`: segments a volume with SAM 3.1 through the run's gateway, next to the data.
 * Input is JSON on stdin (`samInput`); stdout is one JSON line, the result (`SamResult`) or
 * `{error, infrastructure?}` with exit code 1; progress goes to stderr. Environment:
 * `VOLUMA_GATEWAY_URL` and `VOLUMA_GATEWAY_TOKEN`.
 */
import { samInput } from "./input";
import { Failure } from "./meta";
import { run } from "./run";

const log = (line: string) => process.stderr.write(`${line}\n`);

try {
  const gatewayUrl = process.env.VOLUMA_GATEWAY_URL;
  const token = process.env.VOLUMA_GATEWAY_TOKEN;
  if (!gatewayUrl || !token)
    throw new Failure("VOLUMA_GATEWAY_URL and VOLUMA_GATEWAY_TOKEN must be set");
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk;
  const input = samInput.parse(JSON.parse(stdin));
  console.log(JSON.stringify(await run(input, { gatewayUrl, token }, log)));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(
    JSON.stringify({
      error: message,
      ...(error instanceof Failure && error.infrastructure ? { infrastructure: true } : {}),
    }),
  );
  process.exitCode = 1;
}
