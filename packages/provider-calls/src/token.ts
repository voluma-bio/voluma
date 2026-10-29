/**
 * The gateway token: what the runner mints for a sandbox and the gateway opens. The token is
 * identity only; whether the run may spend is the database's answer (`admit`). AES-256-GCM
 * under a secret `{kid, key}`; the `kid` rides in the clear (and is bound as additional data)
 * so the gateway can hold several secrets while one is rotated out.
 *
 * `leaseHash` is the SHA-256 of the claim's lease token, so a sandbox that reads its token
 * cannot use it as the lease. `exp` is the sandbox's lifetime plus a margin.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const PROVIDER_NAMES = ["meta", "anthropic", "openai"] as const;
export type Provider = (typeof PROVIDER_NAMES)[number];

export type TokenSecret = { kid: string; key: Buffer };

export type TokenClaims = {
  runId: string;
  leaseHash: string;
  sandbox: string;
  providers: Provider[];
  /** Unix seconds. */
  exp: number;
  /** A visitor's own keys: when present they are the only keys this token can spend. */
  visitorKeys?: Partial<Record<Provider, string>>;
};

/** How long a token outlives its sandbox's lifetime. */
const MARGIN_SECONDS = 600;
const VERSION = "v1";

export const hashLease = (leaseToken: string) =>
  createHash("sha256").update(leaseToken, "utf8").digest("hex");

export function mintGatewayToken(
  claims: {
    runId: string;
    leaseToken: string;
    sandbox: string;
    providers: Provider[];
    lifetimeSeconds: number;
    visitorKeys?: Partial<Record<Provider, string>>;
  },
  secret: TokenSecret,
): string {
  const body: TokenClaims = {
    runId: claims.runId,
    leaseHash: hashLease(claims.leaseToken),
    sandbox: claims.sandbox,
    providers: claims.providers,
    exp: Math.floor(Date.now() / 1000) + claims.lifetimeSeconds + MARGIN_SECONDS,
    ...(claims.visitorKeys && { visitorKeys: claims.visitorKeys }),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret.key, iv);
  cipher.setAAD(Buffer.from(secret.kid));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
  const packed = Buffer.concat([iv, sealed, cipher.getAuthTag()]);
  return `${VERSION}.${secret.kid}.${packed.toString("base64url")}`;
}

/** The claims of a token one of `secrets` sealed and that has not expired; null otherwise. */
export function openGatewayToken(
  token: string,
  secrets: readonly TokenSecret[],
): TokenClaims | null {
  const [version, kid, packed, ...rest] = token.split(".");
  if (version !== VERSION || !kid || !packed || rest.length > 0) return null;
  const secret = secrets.find((s) => s.kid === kid);
  if (!secret) return null;
  const bytes = Buffer.from(packed, "base64url");
  if (bytes.length < 12 + 16) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", secret.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(kid));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const text = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    const claims = JSON.parse(text) as TokenClaims;
    return claims.exp > Date.now() / 1000 ? claims : null;
  } catch {
    // A wrong key, a forged or truncated token: all are "not a token of ours".
    return null;
  }
}

/** `GATEWAY_TOKEN_SECRET`: `<kid>:<base64 of 32 bytes>`, several separated by commas (first mints). */
export function parseTokenSecrets(text: string): TokenSecret[] {
  const secrets = text.split(",").map((part) => {
    const [kid, b64] = part.trim().split(":");
    const key = Buffer.from(b64 ?? "", "base64");
    if (!kid || key.length !== 32) {
      throw new Error("GATEWAY_TOKEN_SECRET must be <kid>:<base64 of 32 bytes>[,<kid>:…]");
    }
    // A token is `v1.<kid>.<sealed>`, split on dots.
    if (kid.includes("."))
      throw new Error(`GATEWAY_TOKEN_SECRET kid "${kid}" must not contain "."`);
    return { kid, key };
  });
  const kids = new Set(secrets.map((s) => s.kid));
  if (kids.size !== secrets.length) throw new Error("GATEWAY_TOKEN_SECRET repeats a kid");
  return secrets;
}
