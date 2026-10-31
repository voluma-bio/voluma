/**
 * The sandbox spec of a layout (`SandboxLayout`), the one place a sandbox's size and network are
 * written. The layout fixes the mounts and their access (a checker's `/outputs` is read-only,
 * the convert sandbox's `/evidence` too) and whether the sandbox may reach the gateway; this adds the
 * size, the lifetime and, for a sandbox that may reach it, the gateway.
 *
 * All sandboxes are 2 CPUs and 8 GiB: a worker or checker renders volumes, a convert sandbox
 * holds a 1.25 GB float32 stack beside the DICOM.
 */
import type { SandboxLayout } from "./layout";
import type { SandboxSpec } from "./ports/sandbox";

const CPU = 2;
const MEMORY_MIB = 8192;

export interface SandboxSettings {
  runId: string;
  image: string;
  lifetimeSeconds: number;
  idleSeconds: number;
}

export interface Gateway {
  url: string;
  token: string;
  ipv4?: string;
}

/**
 * A gateway's dedicated IPv4 replaces its SNI allowlist; without an IPv4, shared edges can still
 * route by Host (#236). The URL and token go in the environment. A sandbox whose layout does not
 * reach the gateway, or with no gateway given: no network.
 */
export function specOf(
  layout: SandboxLayout,
  settings: SandboxSettings,
  gateway?: Gateway,
): SandboxSpec {
  const reach = layout.gateway ? gateway : undefined;
  // Keep HTTPS/443 required even when the network restriction is an IP rather than SNI.
  const host = reach && gatewayHost(reach.url);
  return {
    runId: settings.runId,
    name: layout.name,
    image: settings.image,
    cpu: CPU,
    memoryMiB: MEMORY_MIB,
    lifetimeSeconds: settings.lifetimeSeconds,
    idleSeconds: settings.idleSeconds,
    mounts: layout.mounts,
    env: reach
      ? { ...layout.env, VOLUMA_GATEWAY_URL: reach.url, VOLUMA_GATEWAY_TOKEN: reach.token }
      : layout.env,
    workdir: layout.dir,
    network:
      reach && host
        ? reach.ipv4 !== undefined
          ? { kind: "ipv4", address: reach.ipv4 }
          : { kind: "hosts", hosts: [host] }
        : { kind: "none" },
  };
}

// Probed: plain HTTP to an allowlisted host is refused. A port other than 443 is unprobed,
// and the allowlist names hosts only, so it is refused too.
function gatewayHost(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  if (url.protocol !== "https:" || url.port !== "") {
    throw new Error(`the gateway URL must be https:// with no port: ${gatewayUrl}`);
  }
  return url.hostname;
}
