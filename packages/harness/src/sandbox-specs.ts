/**
 * The sandbox spec of each role (`SandboxRole`), the one place a role's size, network and
 * mount access are written. A caller names the mounts; the builder fixes their access, so a
 * checker cannot be given a writable `/outputs` nor a convert sandbox a network.
 *
 * | role    | read-only mounts       | writable mounts            | network                     |
 * |---------|------------------------|----------------------------|-----------------------------|
 * | worker  | as the caller says     | as the caller says         | the gateway host, if any    |
 * | checker | `readOnly`             | `scratch` (its own prefix) | none                        |
 * | convert | `evidence`             | `review`                   | none                        |
 *
 * All three are 2 CPUs and 8 GiB: a worker or checker renders volumes, a convert sandbox
 * holds a 1.25 GB float32 stack beside the DICOM.
 */
import type { SandboxMount, SandboxSpec } from "./ports/sandbox";

const CPU = 2;
const MEMORY_MIB = 8192;
const LIFETIME_SECONDS = 14400;
const IDLE_SECONDS = 300;

interface Common {
  runId: string;
  /** Unique within the run: `<taskId>.worker[.n]`, `<taskId>.check[.n]`, or the convert job's name. */
  name: string;
  image: string;
  lifetimeSeconds?: number;
  idleSeconds?: number;
}

const base = (c: Common) => ({
  runId: c.runId,
  name: c.name,
  image: c.image,
  cpu: CPU,
  memoryMiB: MEMORY_MIB,
  lifetimeSeconds: c.lifetimeSeconds ?? LIFETIME_SECONDS,
  idleSeconds: c.idleSeconds ?? IDLE_SECONDS,
});

const withAccess = (mounts: SandboxMount[], access: SandboxMount["access"]): SandboxMount[] =>
  mounts.map((m) => ({ ...m, access }));

/**
 * A worker. With a `gateway` it reaches that host only (over HTTPS) and finds its URL and
 * token in `VOLUMA_GATEWAY_URL` and `VOLUMA_GATEWAY_TOKEN`; without one it has no network.
 */
export function workerSandboxSpec(
  options: Common & { mounts: SandboxMount[]; gateway?: { url: string; token: string } },
): SandboxSpec {
  const { gateway } = options;
  return {
    ...base(options),
    role: "worker",
    mounts: options.mounts,
    network: gateway ? { kind: "hosts", hosts: [new URL(gateway.url).hostname] } : { kind: "none" },
    env: gateway
      ? { VOLUMA_GATEWAY_URL: gateway.url, VOLUMA_GATEWAY_TOKEN: gateway.token }
      : undefined,
  };
}

/** A checker: reads everything in `readOnly`, writes only its own `scratch` prefix. */
export function checkerSandboxSpec(
  options: Common & { readOnly: SandboxMount[]; scratch: SandboxMount },
): SandboxSpec {
  return {
    ...base(options),
    role: "checker",
    mounts: [
      ...withAccess(options.readOnly, "read-only"),
      ...withAccess([options.scratch], "read-write"),
    ],
    network: { kind: "none" },
  };
}

/** A review-asset conversion: reads `evidence`, writes the `review` prefixes. */
export function convertSandboxSpec(
  options: Common & { evidence: SandboxMount[]; review: SandboxMount[] },
): SandboxSpec {
  return {
    ...base(options),
    role: "convert",
    mounts: [
      ...withAccess(options.evidence, "read-only"),
      ...withAccess(options.review, "read-write"),
    ],
    network: { kind: "none" },
  };
}
