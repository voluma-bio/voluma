/**
 * Meta's Model API (`sam-3.1`, Standard mode: content is not used for training), reached
 * through the run's gateway (`$VOLUMA_GATEWAY_URL/meta/v1/...`, the sandbox's token as the
 * bearer): the gateway adds Meta's key and meters the call. One call is an upload of the
 * encoded stack and one streamed request tracking the boxed structures both ways.
 *
 * Failures that are the gateway's or the network's, not the request's, are `Failure`s with
 * `infrastructure` set, which the tool passes on so the agent knows to retry.
 */
import { once } from "node:events";
import { createWriteStream, openAsBlob } from "node:fs";
import { Agent, FormData, fetch, type Response } from "undici";

export class Failure extends Error {
  constructor(
    message: string,
    readonly infrastructure = false,
  ) {
    super(message);
  }
}

/** A quiet SAM call can take many minutes; undici's default of 300 s would cut it. */
const THIRTY_MINUTES = 30 * 60_000;
const dispatcher = new Agent({ headersTimeout: THIRTY_MINUTES, bodyTimeout: THIRTY_MINUTES });
/** Waits before each retry of a call the gateway answered 429 (too many in flight). */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function failure(res: Response): Promise<string> {
  return `${res.status} ${(await res.text()).slice(0, 500)}`;
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
        throw new Failure(`${what}: no answer from the gateway (${cause ?? String(error)})`, true);
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

  /** Throws the right failure for a reply that is not a success. */
  async function expectOk(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    const detail = await failure(res);
    if (res.status === 401)
      throw new Failure(`${what}: the gateway refused this run's token (${detail})`, true);
    if (res.status >= 500) throw new Failure(`${what}: ${detail}`, true);
    if (res.status === 402)
      throw new Failure(`${what}: the run's spend cap is reached (${detail})`);
    throw new Failure(`${what}: ${detail}`);
  }

  return {
    /** Uploads the video and returns its file id. */
    async upload(path: string): Promise<string> {
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
    },

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
    ): Promise<{ requestId: string | undefined; waitMs: number; receiveMs: number }> {
      const request = () =>
        send(
          () =>
            fetch(`${base}/responses`, {
              method: "POST",
              headers: { ...auth, "Content-Type": "application/json", Accept: "text/event-stream" },
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
          "Meta request",
        );
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
      let first: number | undefined;
      try {
        for await (const chunk of res.body) {
          first ??= Date.now();
          if (!file.write(chunk)) await once(file, "drain");
        }
      } catch (error) {
        file.destroy();
        throw new Failure(`Meta request: the reply was cut off (${String(error)})`, true);
      }
      file.end();
      await once(file, "finish");
      const end = Date.now();
      return {
        requestId: res.headers.get("x-request-id") ?? undefined,
        waitMs: (first ?? end) - started,
        receiveMs: end - (first ?? end),
      };
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
