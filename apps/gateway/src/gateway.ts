/**
 * The provider gateway: a streaming reverse proxy that sandboxes reach providers through. A
 * request is `/<provider>/<upstream path>` with `Authorization: Bearer <gateway token>` (or the
 * `x-api-key` Anthropic's SDK sends). In order: open the token; check the provider, our key (a
 * visitor's token has only its own keys and never falls back to ours), the exact route and, for
 * a model call, the model (read from the top level of the first 4 KB of the body); admit the call against the
 * database (`admitCall`: run live, lease matches, in-flight limit, spend cap, `open` row with
 * its reservation); forward with our key and the caller's auth headers stripped; stream the
 * reply back unbuffered while reading usage from its lines; settle the row.
 *
 * Gateway-made refusals are JSON `{error: {type: "gateway", message}}` with 401 (token or run
 * revoked), 402 (spend cap), 403 (route, model, provider or key not allowed), 429 (calls in
 * flight), 502 (provider unreachable) or 503 (database, or draining). A model call that asks for
 * `text/event-stream` is instead answered 200 at once after admission, and an upstream failure
 * (status or unreachable) ends the stream with one `event: error`. A call lasts at most
 * `MAX_CALL_MS`, then it is aborted and cut. A call whose row cannot be written is
 * not made. Nothing from a body is stored or logged.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  admitCall,
  costUsd,
  fileIdOf,
  hasPrice,
  isFinalEvent,
  isProvider,
  MAX_CALL_MS,
  type Matched,
  matchRoute,
  type Observed,
  observeLine,
  openGatewayToken,
  PROVIDERS,
  type Provider,
  providerCalls,
  reservationUsd,
  type Settled,
  settleCall,
  type TokenSecret,
} from "@voluma/provider-calls";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Agent, fetch } from "undici";
import { BodyScanner } from "./body.ts";
import { replyScanner } from "./scan.ts";

/** How much of a model call's body is read for its model name and `max_tokens`. */
const PEEK_BYTES = 4096;
/** Upstream timeouts: SAM can be quiet for minutes on one call, so the 300 s default would cut it. */
const UPSTREAM_TIMEOUT_MS = MAX_CALL_MS;

/**
 * Quiet time on an upstream event stream before the gateway writes a comment line to the client.
 * Railway's edge cuts a response that sends no byte for 300 s (measured), and a SAM call can be
 * quiet that long while Meta processes the video.
 */
const KEEPALIVE_MS = 60_000;
/** Tries to write a call's end to the database before leaving the row for the stale sweep. */
const SETTLE_ATTEMPTS = 3;
/** How much of a failed upstream reply an `error` event carries. */
const ERROR_EXCERPT_BYTES = 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
/** Request headers that are the caller's identity or would change the body we read. */
const STRIPPED_REQUEST = new Set([
  ...HOP_BY_HOP,
  "host",
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "accept-encoding",
]);
/** Errors from a connection that never reached the provider: nothing was billed. */
const CONNECT_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export type GatewayDeps = {
  db: PostgresJsDatabase;
  secrets: readonly TokenSecret[];
  /** Our key per provider; a provider without one serves visitor tokens only. */
  keys: Partial<Record<Provider, string>>;
  /** Where each provider is, default the real one (tests point these at stubs). */
  baseUrls: Record<Provider, string>;
  /** Names this process's rows: it marks them `cut` at shutdown. */
  instance: string;
  log(line: string): void;
};

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createGateway(deps: GatewayDeps) {
  const { db, secrets, keys, baseUrls, instance, log } = deps;
  const dispatcher = new Agent({
    headersTimeout: UPSTREAM_TIMEOUT_MS,
    bodyTimeout: UPSTREAM_TIMEOUT_MS,
  });
  /** Calls being served, to abort at the end of the drain. */
  const active = new Map<string, AbortController>();
  let draining = false;

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof Refused) return reply(res, error.status, error.message);
      log(`unhandled: ${error instanceof Error ? error.message : error}`);
      if (!res.headersSent) reply(res, 500, "gateway error");
      else res.destroy();
    });
  });
  server.requestTimeout = UPSTREAM_TIMEOUT_MS;

  /** Writes a call's end, trying again if the database blinks; a row left `open` is swept as stale. */
  async function settle(id: string, started: number, end: Omit<Settled, "durationMs">) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await settleCall(db, id, { ...end, durationMs: Date.now() - started });
      } catch (error) {
        const message = error instanceof Error ? error.message : error;
        if (attempt === SETTLE_ATTEMPTS) {
          return log(`settle ${id} failed, the row stays open: ${message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const [path = "", query] = (req.url ?? "/").split("?", 2) as [string, string?];
    if (path === "/health") {
      if (draining) return reply(res, 503, "draining");
      await db.execute("select 1");
      return reply(res, 200, "ok");
    }
    if (draining) {
      res.setHeader("connection", "close");
      throw new Refused(503, "draining");
    }
    // Listening from the first await: a caller that leaves during the peek or admission must
    // still stop the call, and a late listener would never hear a close that already happened.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const name = /^\/([a-z]+)(\/.*)$/.exec(path);
    const provider = name?.[1];
    const upstreamPath = name?.[2];
    if (!provider || !upstreamPath || !isProvider(provider))
      throw new Refused(403, "unknown route");

    const token = bearerOf(req);
    const claims = token ? openGatewayToken(token, secrets) : null;
    if (!claims) throw new Refused(401, "invalid or expired token");
    if (!claims.providers.includes(provider)) throw new Refused(403, `no access to ${provider}`);
    // A visitor token holds the visitor's keys and nothing falls back to ours.
    const key = claims.visitorKeys ? claims.visitorKeys[provider] : keys[provider];
    if (!key) throw new Refused(403, `no ${provider} key for this token`);
    const method = req.method ?? "GET";
    const matched = matchRoute(provider, method, upstreamPath);
    if (!matched) throw new Refused(403, `${method} ${upstreamPath} is not allowed`);

    const scanner = new BodyScanner();
    const peek =
      matched.route.kind === "model" ? await peekBody(req, PEEK_BYTES, scanner) : undefined;
    let model: string | null = null;
    let reservedUsd = 0;
    if (peek) {
      const fields = scanner.fields();
      if (typeof fields === "string") throw new Refused(403, fields);
      model = fields.model;
      if (matched.route.models && !matched.route.models.includes(model)) {
        throw new Refused(403, `model ${model} is not allowed on this route`);
      }
      if (!hasPrice(provider, model)) throw new Refused(403, `model ${model} has no price`);
      reservedUsd = reservationUsd(provider, model, fields.maxTokens) ?? 0;
    } else if (matched.fileId) {
      const [own] = await db
        .select({ id: providerCalls.id })
        .from(providerCalls)
        .where(and(eq(providerCalls.runId, claims.runId), eq(providerCalls.fileId, matched.fileId)))
        .limit(1);
      if (!own) throw new Refused(403, "that file was not uploaded by this run");
    }

    const id = randomUUID();
    let refusal: Awaited<ReturnType<typeof admitCall>>;
    try {
      refusal = await admitCall(db, {
        id,
        runId: claims.runId,
        leaseHash: claims.leaseHash,
        sandbox: claims.sandbox,
        provider,
        route: `${method} ${matched.fileId ? `${matched.route.path}{id}` : upstreamPath}`,
        model,
        instance,
        reservedUsd,
        visitor: claims.visitorKeys !== undefined,
      });
    } catch (error) {
      log(`admit failed: ${error instanceof Error ? error.message : error}`);
      throw new Refused(503, "the gateway could not record the call");
    }
    if (refusal) throw new Refused(refusal.status, refusal.reason);

    // The caller left while the call was being admitted: nothing was sent, so nothing was billed.
    if (abort.signal.aborted) {
      await settle(id, Date.now(), { status: "failed", costUsd: 0 });
      return;
    }
    active.set(id, abort);
    const limit = setTimeout(() => abort.abort(), MAX_CALL_MS);
    try {
      await forward(
        { req, res, provider, key, upstreamPath, query, matched, model, id, abort },
        peek,
      );
    } finally {
      clearTimeout(limit);
      active.delete(id);
    }
  }

  async function forward(
    call: {
      req: IncomingMessage;
      res: ServerResponse;
      provider: Provider;
      key: string;
      upstreamPath: string;
      query: string | undefined;
      matched: Matched;
      model: string | null;
      id: string;
      abort: AbortController;
    },
    peek: { body: ReadableStream<Uint8Array> } | undefined,
  ) {
    const { req, res, provider, key, matched, model, id, abort } = call;
    const started = Date.now();
    const seen: Observed = {};
    let fileId: string | undefined;
    let finalEvent = false;
    const end = (end: Omit<Settled, "durationMs">) => settle(id, started, end);

    const headers: Record<string, string> = { ...PROVIDERS[provider].auth(key) };
    for (const [name, value] of Object.entries(req.headers)) {
      if (STRIPPED_REQUEST.has(name) || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    const hasBody = req.method !== "GET" && req.method !== "DELETE";
    const url = `${baseUrls[provider]}${call.upstreamPath}${call.query ? `?${call.query}` : ""}`;

    // A model call that asks for an event stream is answered at once with 200 and the stream's
    // headers, so Railway's edge (which cuts a response with no byte for 300 s) sees bytes
    // while Meta holds its own headers. The upstream's outcome then travels in the stream: its
    // body on 2xx, one `error` event otherwise.
    const early =
      matched.route.kind === "model" && (req.headers.accept ?? "").includes("text/event-stream");
    // Keepalive comments go out after 60 s of quiet, and only at a line start (the last byte
    // written is a newline), where a comment line cannot split anything; mid-line nothing is
    // written and the next chunk re-arms the timer.
    let lastByte = 0x0a;
    let lastWrite = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const keepalive = () => {
      const wait = KEEPALIVE_MS - (Date.now() - lastWrite);
      if (wait > 0) {
        timer = setTimeout(keepalive, wait);
        return;
      }
      if (lastByte === 0x0a && !res.writableNeedDrain) {
        res.write(": keepalive\n");
        lastWrite = Date.now();
      }
      timer = setTimeout(keepalive, KEEPALIVE_MS);
    };
    if (early) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      timer = setTimeout(keepalive, KEEPALIVE_MS);
    }
    /** Ends an early stream with its one terminal error event. */
    const failEarly = (upstreamStatus: number | null, excerpt: string) => {
      const data = JSON.stringify({ upstreamStatus, body: excerpt });
      res.end(`event: error\ndata: ${data}\n\n`);
    };

    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers,
        body: hasBody ? (peek?.body ?? streamOf(req)) : undefined,
        duplex: "half",
        dispatcher,
        signal: abort.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      // A refused connection billed nothing; anything later (a timeout, a reset) may have.
      const code = (error as { cause?: { code?: string } }).cause?.code ?? "";
      const unbilled = CONNECT_ERRORS.has(code);
      await end(unbilled ? { status: "failed", costUsd: 0 } : { status: "cut", costUsd: null });
      if (abort.signal.aborted) return res.destroy();
      log(
        `${id} ${provider} unreachable: ${code || (error as { cause?: Error }).cause?.message || (error instanceof Error ? error.message : error)}`,
      );
      if (early) return failEarly(null, `${provider} is unreachable`);
      throw new Refused(502, `${provider} is unreachable`);
    }
    const ttfbMs = Date.now() - started;
    if (early && upstream.status >= 400) {
      clearTimeout(timer);
      const excerpt = await excerptOf(upstream.body, ERROR_EXCERPT_BYTES).catch(() => "");
      await end({ status: "failed", costUsd: 0, httpStatus: upstream.status, ttfbMs });
      log(`${id} ${provider} ${req.method} ${call.upstreamPath} ${upstream.status} error event`);
      return failEarly(upstream.status, excerpt);
    }
    const encoded = upstream.headers.has("content-encoding");
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (HOP_BY_HOP.has(name) || name === "content-encoding") return;
      if (encoded && name === "content-length") return;
      out[name] = value;
    });
    if (!early) res.writeHead(upstream.status, out);
    // An event stream is read a line at a time; any other reply (possibly pretty-printed JSON)
    // as one text through the bounded window.
    const streamed =
      early || (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    const scan = replyScanner(streamed, (line) => {
      observeLine(line, seen);
      if (isFinalEvent(line)) finalEvent = true;
      if (matched.route.kind === "file-upload" && upstream.status < 400) fileId ??= fileIdOf(line);
    });
    if (!early && streamed) timer = setTimeout(keepalive, KEEPALIVE_MS);

    let complete = false;
    try {
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          scan.push(chunk);
          if (streamed && chunk.length) lastByte = chunk[chunk.length - 1] as number;
          lastWrite = Date.now();
          if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal });
        }
      }
      scan.end();
      res.end();
      complete = true;
    } catch (error) {
      if (!abort.signal.aborted)
        log(`${id} ${provider} stream failed: ${error instanceof Error ? error.message : error}`);
      res.destroy();
    }
    clearTimeout(timer);

    const ok = upstream.status < 400;
    const cost = !ok
      ? 0
      : matched.route.kind === "model"
        ? costUsd(provider, model ?? "", seen)
        : 0;
    // A reply that was cut short, or that reported nothing to price, may still be billed in full.
    // An Anthropic or Responses stream that never reached its last event has partial usage.
    const finished = !streamed || provider === "meta" || finalEvent;
    const known = complete && finished && cost !== null;
    await end({
      status: !ok ? "failed" : known ? "done" : "cut",
      costUsd: !ok ? 0 : known ? cost : null,
      httpStatus: upstream.status,
      ...(fileId && { fileId }),
      ...seen,
      ttfbMs,
    });
    log(
      `${id} ${provider} ${req.method} ${call.upstreamPath} ${upstream.status} ${complete ? "ok" : "cut"} ttfb=${ttfbMs}ms ${Date.now() - started}ms`,
    );
  }

  return {
    server,
    /** Stops taking calls, waits up to `ms` for those in flight, then aborts what is left. */
    async drain(ms: number) {
      draining = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const timer = setTimeout(() => {
        for (const abort of active.values()) abort.abort();
        server.closeAllConnections();
      }, ms);
      await closed;
      clearTimeout(timer);
      dispatcher.close().catch(() => {});
    },
  };
}

function reply(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) return;
  const body = JSON.stringify({ error: { type: "gateway", message } });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** The first `limit` bytes of a body as text (a character cut by the limit is replaced), then the body is dropped. */
async function excerptOf(body: AsyncIterable<Uint8Array> | null, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (body) {
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      if (size >= limit) break;
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.concat(chunks).subarray(0, limit),
  );
}

function bearerOf(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const key = req.headers["x-api-key"];
  return typeof key === "string" ? key : undefined;
}

/** The request body as a web stream (an upload, never held in memory). */
const streamOf = (req: IncomingMessage) => Readable.toWeb(req) as ReadableStream<Uint8Array>;

/**
 * Reads up to `limit` bytes of the body for the scanner's admission decision; `body` replays
 * them, then the rest. The scanner sees every byte as it passes; a violation after the window
 * errors the stream, which aborts the upstream request.
 */
async function peekBody(req: IncomingMessage, limit: number, scanner: BodyScanner) {
  const chunks: Buffer[] = [];
  let size = 0;
  let ended = false;
  const iterator = req[Symbol.asyncIterator]();
  while (size < limit) {
    const next = await iterator.next();
    if (next.done) {
      ended = true;
      break;
    }
    chunks.push(next.value as Buffer);
    size += (next.value as Buffer).length;
  }
  const head = Buffer.concat(chunks);
  scanner.push(head.subarray(0, limit));
  const refuse = (controller: ReadableStreamDefaultController<Uint8Array>, reason: string) => {
    controller.error(new Error(`request body refused: ${reason}`));
    req.destroy();
  };
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const reason = scanner.push(head.subarray(limit));
        if (reason) return refuse(controller, reason);
        if (head.length) controller.enqueue(head);
        if (ended) controller.close();
      },
      async pull(controller) {
        if (ended) return;
        const next = await iterator.next();
        if (next.done) return controller.close();
        const reason = scanner.push(next.value as Buffer);
        if (reason) return refuse(controller, reason);
        controller.enqueue(next.value as Buffer);
      },
      cancel() {
        req.destroy();
      },
    }),
  };
}
