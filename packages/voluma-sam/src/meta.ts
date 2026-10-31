/**
 * Meta's Model API (`sam-3.1`, Standard mode: content is not used for training), reached
 * through the run's gateway (`$VOLUMA_GATEWAY_URL/meta/v1/...`, the sandbox's token as the
 * bearer): the gateway adds Meta's key and meters each request. One SAM operation normally
 * makes three gateway requests: upload the encoded stack, stream the response tracking
 * the boxed structures both ways, then delete the uploaded file. Retries add requests.
 *
 * Failures that are the gateway's or the network's, not the request's, are `Failure`s with
 * `infrastructure` set, which the tool passes on so the agent knows to retry.
 */
import { once } from "node:events";
import { createWriteStream, openAsBlob } from "node:fs";
import { Agent, FormData, fetch, Response } from "undici";
import type { StreamStats } from "./input";

export class Failure extends Error {
  constructor(
    message: string,
    readonly infrastructure = false,
    /** The gateway or network cut the request (so a redeploy may be the cause), not a status it answered. */
    readonly transport = false,
  ) {
    super(message);
  }
}

/** A quiet SAM call can take many minutes; undici's default of 300 s would cut it. */
const THIRTY_MINUTES = 30 * 60_000;
/** The gateway aborts a call at this age (`MAX_CALL_MS` in packages/provider-calls); this package cannot import it. */
const MAX_CALL_MS = THIRTY_MINUTES;
const dispatcher = new Agent({ headersTimeout: THIRTY_MINUTES, bodyTimeout: THIRTY_MINUTES });
/** Waits before each retry of a call the gateway answered 429 (too many in flight). */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function failure(res: Response): Promise<string> {
  return `${res.status} ${(await res.text()).slice(0, 500)}`;
}

const GATEWAY_ERROR = "event: gateway-error";

/**
 * The gateway answers a streaming call with 200 and event-stream headers at once, before Meta
 * has answered, and reports a failed upstream as one `event: gateway-error` whose data is
 * `{upstreamStatus, body, requestId}` (after any `:` keepalive comments). This turns that event
 * back into the reply it stands for (`upstreamStatus` as the status, 502 when null or invalid, `body` as
 * the text), so the callers see the statuses Meta gave. A stream that starts any other way is
 * returned as it is, unread past its first bytes.
 */
async function streamReply(pending: Promise<Response>): Promise<Response> {
  const res = await pending;
  if (!res.ok || !res.body) return res;
  const reader = res.body.getReader();
  const seen: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let head = "";
  let rest = "";
  let ended = false;
  while (!ended && (rest.length < GATEWAY_ERROR.length || rest.startsWith(":"))) {
    const next = await reader.read();
    if (next.done) {
      ended = true;
      break;
    }
    seen.push(next.value);
    head += decoder.decode(next.value, { stream: true });
    rest = head.replace(/^(?:\r?\n|:[^\n]*\n)+/, "");
  }
  if (rest.startsWith(GATEWAY_ERROR)) {
    let text = head;
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      text += decoder.decode(read.value, { stream: true });
      if (text.length > 64 * 1024) break;
    }
    const data = /^data: (.*)$/m.exec(text)?.[1];
    let event: { upstreamStatus?: unknown; body?: unknown } = {};
    try {
      event = JSON.parse(data ?? "{}");
    } catch {}
    const status = Number(event.upstreamStatus);
    return new Response(typeof event.body === "string" ? event.body : "", {
      status: Number.isInteger(status) && status >= 400 && status < 600 ? status : 502,
    });
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of seen) controller.enqueue(chunk);
      if (ended) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, { status: res.status, headers: res.headers });
}

export function metaClient(options: { url: string; token: string; log(line: string): void }) {
  const { log } = options;
  const base = `${options.url.replace(/\/+$/, "")}/meta/v1`;
  const auth = { Authorization: `Bearer ${options.token}` };

  /** The reply to `make()`, retried while the gateway says 429. Transport errors are infrastructure. */
  async function send(make: () => Promise<Response>, what: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await make();
      } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause?.code;
        throw new Failure(
          `${what}: no answer from the gateway (${cause ?? String(error)})`,
          true,
          true,
        );
      }
      if (res.status !== 429) return res;
      const detail = await failure(res);
      const wait = BACKOFF_MS[attempt];
      if (wait === undefined)
        throw new Failure(`${what}: the gateway stayed busy: ${detail}`, true);
      log(`${what}: the gateway has too many calls in flight, retrying in ${wait / 1000} s`);
      await sleep(wait);
    }
  }

  /**
   * A gateway redeploy cuts the calls its old instance still holds, and the new instance takes
   * the next one: an infrastructure failure is retried once. A retried SAM request is a second
   * paid request (the cut one stays a `cut` row of unknown cost). A first try that ran to the
   * gateway's time limit is not retried: it would hit the limit again.
   */
  async function again<T>(run: () => Promise<T>): Promise<T> {
    const begun = Date.now();
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof Failure && error.infrastructure)) throw error;
      if (Date.now() - begun >= MAX_CALL_MS - 60_000) throw error;
      log(`${error.message}; trying once more`);
      return run().catch((second) => {
        if (second instanceof Failure && second.infrastructure)
          throw new Failure(
            second.transport
              ? `${second.message}. Tried twice, so the gateway may be redeploying or down: call segment_sam again after a minute, or carry on without it.`
              : `${second.message}. Tried twice.`,
            true,
            second.transport,
          );
        throw second;
      });
    }
  }

  /** Throws the right failure for a reply that is not a success. */
  async function expectOk(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    const detail = await failure(res);
    if (res.status === 401)
      throw new Failure(`${what}: the gateway refused this run's token (${detail})`, true);
    if (res.status >= 500) throw new Failure(`${what}: ${detail}`, true);
    throw new Failure(`${what}: ${detail}`);
  }

  return {
    /** Uploads the video and returns its file id. */
    upload: (path: string): Promise<string> =>
      again(async () => {
        const res = await send(async () => {
          const form = new FormData();
          form.set("purpose", "user_data");
          form.set("file", await openAsBlob(path, { type: "video/mp4" }), "stack.mp4");
          return fetch(`${base}/files`, { method: "POST", headers: auth, body: form, dispatcher });
        }, "Meta upload");
        await expectOk(res, "Meta upload");
        const id = ((await res.json()) as { id?: string }).id;
        if (!id) throw new Failure("Meta's upload reply had no file id");
        return id;
      }),

    /** The user's scan must not stay in Meta's file store: a failed delete is loud, not fatal. */
    async remove(id: string, timeoutMs = 60_000): Promise<void> {
      const res = await fetch(`${base}/files/${id}`, {
        method: "DELETE",
        headers: auth,
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((e: Error) => e);
      if (res instanceof Error || !res.ok) {
        log(`Meta file ${id} was NOT deleted: ${res instanceof Error ? res.message : res.status}`);
      }
    },

    /**
     * Sends the tracking request and streams its reply to `out`. `asked` describes the
     * objects, for the message when Meta answers 404 twice.
     */
    async track(
      prompt: string,
      fileId: string,
      out: string,
      asked: string,
    ): Promise<{
      requestId: string | undefined;
      waitMs: number;
      receiveMs: number;
      stream: StreamStats;
    }> {
      const request = () =>
        send(
          () =>
            streamReply(
              fetch(`${base}/responses`, {
                method: "POST",
                headers: {
                  ...auth,
                  "Content-Type": "application/json",
                  Accept: "text/event-stream",
                },
                body: JSON.stringify({
                  model: "sam-3.1",
                  stream: true,
                  metadata: { propagation_direction: "both", include_confidence: "true" },
                  input: [
                    {
                      type: "message",
                      role: "user",
                      content: [
                        { type: "input_text", text: prompt },
                        { type: "input_video", file_id: fileId },
                      ],
                    },
                  ],
                }),
                dispatcher,
              }),
            ),
          "Meta request",
        );
      /** One request and its whole reply written to `out`. */
      const attempt = async () => {
        const started = Date.now();
        let res = await request();
        // Meta answers `404 model_not_found` for some prompts (a small box), not only for an outage,
        // and bills nothing for it. Once more on the uploaded file costs nothing if it fails again.
        if (res.status === 404) {
          log(`Meta answered 404 to a SAM request: ${await failure(res)}; trying once more`);
          res = await request();
        }
        if (res.status === 404) {
          throw new Failure(
            `Meta answered 404 twice to this request: ${await failure(res)}. It bills nothing for a failed ` +
              `call. Either this input is the cause (seen once: a small box prompt failed on every call ` +
              `while the other objects succeeded) or Meta is down. Asked for: ${asked}. To tell which: ` +
              `try once more with the smallest or least certain object left out or given a larger box ` +
              `(a call that succeeds costs about $0.07-0.10). If that also gets a 404, stop calling ` +
              `segment_sam and report the outage.`,
          );
        }
        await expectOk(res, "Meta request");
        if (!res.body) throw new Failure("Meta request: the reply had no body", true);
        const file = createWriteStream(out);
        const watch = streamWatch(started);
        try {
          for await (const chunk of res.body) {
            watch.add(chunk);
            if (!file.write(chunk)) await once(file, "drain");
          }
        } catch (error) {
          file.destroy();
          throw new Failure(`Meta request: the reply was cut off (${String(error)})`, true, true);
        }
        // A proxy may close a cut stream cleanly: only response.completed shows it was whole.
        if (!watch.completed)
          throw new Failure(
            "Meta request: the reply ended before response.completed, so it was cut off",
            true,
            true,
          );
        file.end();
        await once(file, "finish");
        return { res, watch, started };
      };
      const { res, watch, started } = await again(attempt);
      const end = Date.now();
      // Wait ends at the first `data:` line: the gateway's keepalive comments are not arrivals.
      const waitMs = watch.stats.firstEventMs ?? end - started;
      return {
        requestId: res.headers.get("x-request-id") ?? undefined,
        waitMs,
        receiveMs: end - started - waitMs,
        stream: watch.stats,
      };
    },
  };
}

/** Measures the reply chunk by chunk: cost per chunk is its length, however long the stream. */
const COMPLETED = Buffer.from("response.completed");

function streamWatch(started: number) {
  const LINE = Buffer.from("\ndata: ");
  const stats: StreamStats = {
    firstEventMs: undefined,
    longestGapMs: 0,
    longestGapAtMs: 0,
    bytes: 0,
    events: 0,
  };
  let last = started;
  let completed = false;
  // The last bytes of the previous chunk, so COMPLETED is found across a chunk edge.
  let before: Buffer = Buffer.alloc(0);
  // The last 6 bytes (one short of LINE): a match across two chunks starts in them.
  let tail: Buffer = Buffer.from("\n");
  const keepalive = (chunk: Buffer) =>
    tail[tail.length - 1] === 0x0a &&
    chunk[0] === 0x3a &&
    chunk.at(-1) === 0x0a &&
    chunk.at(-2) === 0x0a;
  return {
    stats,
    get completed() {
      return completed;
    },
    add(bytes: Uint8Array) {
      // undici yields plain Uint8Arrays, whose indexOf takes a byte, not a pattern: view as a Buffer, no copy.
      const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
      const now = Date.now();
      stats.bytes += chunk.length;
      let seen = 0;
      // A match starting in the tail ends in the chunk's first bytes; the chunk itself is searched in place.
      const edge = Buffer.concat([tail, chunk.subarray(0, LINE.length - 1)]);
      for (
        let at = edge.indexOf(LINE);
        at >= 0 && at < tail.length;
        at = edge.indexOf(LINE, at + 1)
      )
        seen++;
      for (let at = chunk.indexOf(LINE); at >= 0; at = chunk.indexOf(LINE, at + 1)) seen++;
      // A gap ends on any chunk but a lone keepalive comment (`: keepalive`): a very long
      // `data:` line arrives over many chunks, and that is not silence.
      if (!keepalive(chunk)) {
        if (now - last > stats.longestGapMs) {
          stats.longestGapMs = now - last;
          stats.longestGapAtMs = now - started;
        }
        last = now;
      }
      if (!completed) {
        completed = Buffer.concat([before, chunk]).includes(COMPLETED);
        before = chunk.subarray(-(COMPLETED.length - 1));
      }
      if (seen) stats.firstEventMs ??= now - started;
      stats.events += seen;
      const keep = LINE.length - 1;
      tail =
        chunk.length >= keep
          ? chunk.subarray(chunk.length - keep)
          : Buffer.concat([tail, chunk]).subarray(-keep);
    },
  };
}

/** `<frame>f` then `label<|box;x1;y1;x2;y2;w;h|>` for each box on that frame. */
export function promptText(
  objects: { label: number; frame: number; box: [number, number, number, number] }[],
  width: number,
  height: number,
): string {
  const byFrame = new Map<number, string[]>();
  for (const { label, frame, box } of objects) {
    const [r0, c0, r1, c1] = box;
    const entry = `${label}<|box;x1=${c0};y1=${r0};x2=${c1};y2=${r1};w=${width};h=${height}|>`;
    byFrame.set(frame, [...(byFrame.get(frame) ?? []), entry]);
  }
  return [...byFrame]
    .sort(([a], [b]) => a - b)
    .map(([frame, entries]) => `<${frame}f>${entries.join(",")}`)
    .join("");
}
