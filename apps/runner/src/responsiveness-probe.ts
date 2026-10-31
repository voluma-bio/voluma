/** Free, local stress replay for #130. Uses real HTTP and filesystem IO; never calls a provider. */
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { evidenceKey, outputKey } from "@voluma/contracts/r2";
import { runClient } from "@voluma/harness/adapters/http/run-client";
import { liveBatcher } from "@voluma/harness/live";
import { TOOL_NAMES } from "@voluma/harness/tools";
import { directoryStore } from "@voluma/object-store/directory";
import { r2Store } from "@voluma/object-store/r2";
import { loadWorkflow } from "@voluma/workflow/load";
import { withImageRefs } from "../../../packages/harness/src/adapters/pi/image-refs.ts";
import { startThread } from "../../../packages/harness/src/adapters/pi/start-thread.ts";
import { runLayout } from "../../../packages/harness/src/layout.ts";
import { recorder } from "../../../packages/harness/src/recorder.ts";
import { bashTool } from "../../../packages/harness/src/tools/bash.ts";
import { holdLease } from "./lease.ts";
import { retryTransient } from "./model-retry.ts";
import { redactor } from "./redact.ts";
import { storeEvidence } from "./store-evidence.ts";
import { storeFiles } from "./store-files.ts";
import { usageMeter } from "./usage.ts";

const root = resolve(import.meta.dirname, "../../..");
const scratch = await mkdtemp(join(tmpdir(), "voluma-130-"));
const objects = directoryStore(join(scratch, "objects"), "/unused");
const files = storeFiles(objects);
const baseline = process.argv.includes("--baseline");
const rows: string[] = [];
let liveChars = 0;
let liveFrames = 0;
let heartbeats = 0;
let leaseFailures = 0;
const server = fork(join(import.meta.dirname, "responsiveness-server.mjs"), [scratch], {
  execArgv: [],
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
const [port] = await once(server, "message");
const baseUrl = `http://127.0.0.1:${port}`;
const client = runClient(
  { baseUrl, token: "local-probe" },
  { runId: "probe", leaseToken: "local-lease" },
  {
    redact: redactor(["probe-secret-key"]),
    onLeaseLost() {
      leaseFailures++;
    },
  },
);
const lease = holdLease({
  client,
  meter: usageMeter(),
  onStop() {
    leaseFailures++;
  },
  onRoundTrip() {
    heartbeats++;
  },
  log: console.error,
});

async function measure(name: string, work: () => Promise<unknown>, maxLateMs = 45_000) {
  await sleep(30);
  let last = performance.now();
  let late = 0;
  let samples = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    late = Math.max(late, now - last - 10);
    last = now;
    samples++;
  }, 10);
  const start = performance.now();
  try {
    const result = await work();
    const wallMs = performance.now() - start;
    await sleep(20);
    console.log(
      JSON.stringify({
        name,
        wallMs: Math.round(wallMs),
        maxTimerLateMs: Math.round(late),
        samples,
        rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20),
        result,
      }),
    );
    assert(late < maxLateMs, `${name}: timer late ${Math.round(late)}ms >= ${maxLateMs}ms`);
  } finally {
    clearInterval(timer);
  }
}

try {
  // Optional read-only replay of an exported real run. Existing evidence is HEADed
  // before keep(), so this probe never creates evidence or workflow objects in R2.
  const archivePath = process.argv.find((a) => a.startsWith("--archive="))?.slice(10);
  if (archivePath) {
    const archive = JSON.parse(await readFile(archivePath, "utf8")) as {
      run: { id: string };
      piMessages: { threadId: string; idx: number; message: string }[];
      events: {
        payload: {
          taskId?: string;
          evidence?: { root: "outputs"; path: string; sha256: string }[];
        };
      }[];
    };
    const config = {
      accountId: process.env.R2_ACCOUNT_ID ?? "",
      bucket: process.env.R2_BUCKET ?? "",
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    };
    assert(
      config.accountId && config.bucket && config.accessKeyId && config.secretAccessKey,
      "R2 credentials required for --archive",
    );
    const remote = r2Store(config);
    const readOnly = {
      ...remote,
      async put() {
        throw new Error("probe may not write R2");
      },
      async copy() {
        throw new Error("probe may not copy R2");
      },
    };
    const refs = archive.events.flatMap((e) =>
      (e.payload.evidence ?? [])
        .filter((f) => f.root === "outputs")
        .map((file) => ({ taskId: e.payload.taskId ?? "", file })),
    );
    const unique = [...new Map(refs.map((ref) => [ref.file.sha256, ref])).values()];
    const available = [];
    for (const ref of unique) {
      const source = await remote.head(outputKey(archive.run.id, ref.taskId, ref.file.path));
      const target = await remote.head(evidenceKey(archive.run.id, ref.file.sha256));
      if (source && target && source.size === target.size)
        available.push({ ...ref, bytes: source.size });
    }
    available.sort((a, b) => a.bytes - b.bytes);
    const large = available.at(-1);
    const small = available.filter((ref) => ref.bytes <= 64 * 2 ** 20).at(-1);
    assert(large && small, "need existing large and small evidence with matching sizes");
    const check = await remote.get(outputKey(archive.run.id, small.taskId, small.file.path));
    const verified = createHash("sha256");
    for await (const chunk of check.body) verified.update(chunk);
    assert.equal(
      verified.digest("hex"),
      small.file.sha256,
      "refuse to create new evidence for a rewritten source",
    );
    for (const [name, ref, mounted] of [
      ["mounted", large, true],
      ["unmounted", small, false],
    ] as const) {
      await measure(`evidence-real-${name}`, async () => {
        const kept = await storeEvidence(readOnly).keep(
          archive.run.id,
          ref.taskId,
          ref.file,
          mounted ? { hash: async () => ref.file.sha256 } : undefined,
        );
        assert.equal(kept, ref.file.sha256);
        return {
          bytes: ref.bytes,
          sandboxHash: mounted ? "already recorded hash; sandbox hashing is outside runner" : false,
        };
      });
    }
    await measure("evidence-real-too-large-unmounted", async () => {
      await assert.rejects(
        storeEvidence(readOnly).keep(archive.run.id, large.taskId, large.file),
        /cannot be read here/,
      );
      return { bytes: large.bytes, refused: true };
    });
    const grouped = new Map<string, typeof archive.piMessages>();
    for (const row of archive.piMessages) {
      const group = grouped.get(row.threadId) ?? [];
      group.push(row);
      grouped.set(row.threadId, group);
    }
    const largest = [...grouped.values()].sort(
      (a, b) =>
        b.reduce((n, r) => n + r.message.length, 0) - a.reduce((n, r) => n + r.message.length, 0),
    )[0];
    assert(largest);
    rows.push(...largest.sort((a, b) => a.idx - b.idx).map((r) => r.message));
    await writeFile(join(scratch, "rows.json"), JSON.stringify({ messages: rows }));
    await measure("history-real-largest-thread", async () => {
      const stored = await client.load("probe.main");
      const parsed = stored.map((row) => JSON.parse(row));
      assert.equal(parsed.length, rows.length);
      return { rows: parsed.length, bytes: rows.reduce((n, row) => n + Buffer.byteLength(row), 0) };
    });
    rows.length = 0;
  }
  if (!process.argv.includes("--archive-only")) {
    // Includes nested JSON escaping and redaction, HTTP response parsing, image-ref wrapper,
    // and startThread's actual resume/repair checks. Finished history never calls a model.
    const provider = metaProvider();
    const models = createModels();
    models.setProvider(provider);
    const model = provider.getModels()[0];
    assert(model);
    const system = { role: "system", content: "probe", timestamp: 0 };
    if (!process.argv.includes("--provider-only")) {
      for (const mib of [8, 64, 128]) {
        rows.length = 0;
        rows.push(
          JSON.stringify(system),
          JSON.stringify({ role: "user", content: "probe", timestamp: 0 }),
        );
        const text = 'a"\\\n'.repeat(4096);
        for (let bytes = 0; bytes < mib * 2 ** 20; ) {
          const row = JSON.stringify({
            role: "toolResult",
            toolCallId: "done",
            toolName: "read_file",
            content: [{ type: "text", text }],
            isError: false,
            timestamp: 0,
          });
          rows.push(row);
          bytes += Buffer.byteLength(row);
        }
        rows.push(
          JSON.stringify({
            role: "assistant",
            provider: model.provider,
            model: model.id,
            api: model.api,
            content: [{ type: "text", text: "finished" }],
            stopReason: "stop",
            timestamp: 0,
          }),
        );
        await writeFile(join(scratch, "rows.json"), JSON.stringify({ messages: rows }));
        await measure(`history-resume-${mib}MiB`, async () => {
          const history = withImageRefs(client, files, "probe", () => "main");
          const handle = startThread({
            threadId: "probe.main",
            kind: "main",
            prompt: "probe",
            systemPrompt: "probe",
            model,
            tools: [],
            history,
            recorder: recorder(client, "probe", () => {
              leaseFailures++;
            }),
            streamFn() {
              throw new Error("paid calls forbidden");
            },
            async sandbox() {
              throw new Error("no sandbox expected");
            },
          });
          const outcome = await handle.done;
          assert.equal(outcome.ran, false);
          assert.equal(outcome.status, "completed", outcome.error);
          return {
            rows: rows.length,
            bytes: rows.reduce((n, row) => n + Buffer.byteLength(row), 0),
          };
        });
      }
      rows.length = 0;
      await measure("history-write-4-images-1MiB-each", async () => {
        const data = Buffer.alloc(2 ** 20, 91).toString("base64");
        const history = withImageRefs(client, files, "probe", () => "main");
        await history.appendMessage(
          "probe.main",
          0,
          JSON.stringify({
            role: "toolResult",
            content: Array.from({ length: 4 }, () => ({
              type: "image",
              mimeType: "image/png",
              data,
            })),
          }),
        );
        const stored = JSON.parse(await readFile(join(scratch, "written.json"), "utf8"));
        assert.equal(
          JSON.parse(stored.message).content.filter((b: { type: string }) => b.type === "imageRef")
            .length,
          4,
        );
        assert(stored.message.length < 2000);
        return { imageBytes: 4 * 2 ** 20 };
      });

      const evidenceSource = outputKey("probe", "intake", "boundary.bin");
      await objects.put(evidenceSource, new Uint8Array());
      await truncate(join(scratch, "objects", evidenceSource), 64 * 2 ** 20);
      await measure("evidence-local-64MiB-hash-and-copy", async () => {
        const sha256 = await storeEvidence(objects).keep("probe", "intake", {
          root: "outputs",
          path: "boundary.bin",
        });
        const copied = await objects.get(evidenceKey("probe", sha256));
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of copied.body) {
          bytes += chunk.length;
          hash.update(chunk);
        }
        assert.equal(bytes, 64 * 2 ** 20);
        assert.equal(hash.digest("hex"), sha256);
        return { bytes, copied: true, digestVerified: true };
      });

      for (const state of ["fresh", "resume"])
        await measure(`workflow-${state}`, async () => {
          const definition = await loadWorkflow("workflows/mouse-oa", {
            store: objects,
            prefix: "snapshot/",
            root,
            commit: "probe",
            knownTools: TOOL_NAMES,
          });
          assert(definition.files.tasks.length > 0);
          const { objects: listed } = await objects.list("snapshot/");
          return {
            files: listed.length,
            bytes: listed.reduce((n, o) => n + o.size, 0),
            tasks: definition.files.tasks.length,
          };
        });

      const layout = runLayout({
        runId: "probe",
        inputPrefix: "inputs/",
        skills: [],
        grants: { main: [], worker: [], check: [] },
      }).forThread({
        id: "probe.intake.worker",
        name: "intake.worker",
        role: "worker",
        taskId: "intake",
      });
      await measure("bash-256MiB-64KiB-chunks", async () => {
        let spill = 0;
        const output = await bashTool(layout).execute(
          { command: "probe", timeoutSeconds: 120 },
          {
            threadId: "probe.intake.worker",
            kind: "worker",
            taskId: "intake",
            toolCallId: "call_probe",
            batchSize: 1,
            signal: new AbortController().signal,
            output() {},
            async sandbox() {
              return {
                async *exec() {
                  const child = spawn(
                    process.execPath,
                    [
                      "-e",
                      "(async()=>{const{once}=require('node:events');const b=Buffer.alloc(65536,120);for(let i=0;i<4096;i++)if(!process.stdout.write(b))await once(process.stdout,'drain')})()",
                    ],
                    { stdio: ["ignore", "pipe", "inherit"] },
                  );
                  const exited = once(child, "exit");
                  for await (const data of child.stdout)
                    yield { type: "stdout" as const, data: data.toString() };
                  const [code] = await exited;
                  yield { type: "exit" as const, code };
                },
                async writeFile(_path, bytes) {
                  spill = bytes.length;
                  await writeFile(join(scratch, "bash-spill"), bytes);
                },
                async destroy() {},
                async exitCode() {
                  return null;
                },
              };
            },
          },
        );
        assert(output.output.length < 13000);
        assert.equal(spill, 4_000_000);
        return { inputBytes: 256 * 2 ** 20, resultChars: output.output.length, spill };
      });
      for (const kind of ["oversized", "empty", "normal"] as const)
        await measure(`live-${kind}`, async () => {
          liveChars = liveFrames = 0;
          const batcher = liveBatcher(async (frames) => {
            liveFrames += frames.length;
            liveChars += frames.reduce((n, f) => n + f.text.length, 0);
            await client.live(frames);
          });
          const count = kind === "empty" ? 100_000 : kind === "normal" ? 50_000 : 1;
          for (let i = 0; i < count; i++)
            batcher.push({
              type: "text.delta",
              runId: "probe",
              threadId: "probe.main",
              messageId: kind === "normal" ? "reply" : `reply-${i}`,
              offset: kind === "normal" ? i * 16 : 0,
              text:
                kind === "oversized"
                  ? "x".repeat(8 * 2 ** 20)
                  : kind === "empty"
                    ? ""
                    : "x".repeat(16),
            });
          await batcher.flush();
          assert(liveChars <= 256 * 1024);
          assert(liveFrames <= 1000);
          return { ...batcher.stats(), sentChars: liveChars, sentFrames: liveFrames };
        });
    }
    const compare = process.argv.includes("--compare");
    const cases = compare
      ? Array.from({ length: 10 }, (_, i) => ({
          bytes: 256 * 1024,
          unfixed: i % 2 === 0,
          textOnly: false,
          concurrency: 1,
        }))
      : [64 * 1024, 256 * 1024, 1024 * 1024]
          .map((bytes) => ({ bytes, unfixed: baseline, textOnly: false, concurrency: 1 }))
          .concat([
            { bytes: 16 * 2 ** 20, unfixed: baseline, textOnly: true, concurrency: 1 },
            { bytes: 256 * 1024, unfixed: baseline, textOnly: false, concurrency: 2 },
          ]);
    for (const { bytes, unfixed, textOnly, concurrency } of cases)
      await measure(
        `provider-${textOnly ? "text-line" : "tool-args"}-${bytes}-${unfixed ? "baseline" : "fixed"}-x${concurrency}`,
        async () => {
          const providerChunk = 256;
          await writeFile(
            join(scratch, "provider.json"),
            JSON.stringify({ bytes, chunkBytes: providerChunk, textOnly }),
          );
          const local = { ...model, baseUrl: `${baseUrl}/v1` };
          const raw = models.streamSimple.bind(models);
          const call = unfixed
            ? raw
            : retryTransient(raw, () => {
                throw new Error("no retries expected");
              });
          const replay = async () => {
            const stream = call(
              local,
              { messages: [{ role: "user", content: "probe", timestamp: 0 }] },
              { apiKey: "local-probe", maxRetries: 0 },
            );
            let events = 0;
            for await (const _ of stream) events++;
            const reply = await stream.result();
            assert.notEqual(reply.stopReason, "error", reply.errorMessage);
            if (textOnly) {
              const text = reply.content.find((b) => b.type === "text");
              assert(text?.type === "text");
              assert.equal(text.text, "x".repeat(bytes));
            } else {
              const toolCall = reply.content.find((b) => b.type === "toolCall");
              assert(toolCall?.type === "toolCall");
              assert.equal(toolCall.arguments.command, "x".repeat(bytes));
            }
            return { events, argumentBytes: bytes, chunkBytes: providerChunk };
          };
          return Promise.all(Array.from({ length: concurrency }, replay));
        },
        unfixed ? Number.POSITIVE_INFINITY : 1000,
      );
  }
  console.log(
    JSON.stringify({
      heartbeats,
      leaseFailures,
      note: "local replay only; no paid model or SAM calls",
    }),
  );
  assert.equal(leaseFailures, 0);
} finally {
  lease.halt();
  server.disconnect();
  await once(server, "exit");
  await rm(scratch, { recursive: true, force: true });
}
