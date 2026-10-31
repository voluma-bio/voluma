/** Best-effort live output stays bounded even while its receiver is stalled. */
import type { LiveFrame } from "@voluma/contracts/stream";
import { expect, test } from "vitest";
import { liveBatcher } from "./live";

const frame = (text: string, messageId = "reply", offset = 0): LiveFrame => ({
  type: "text.delta",
  runId: "probe",
  threadId: "probe.main",
  messageId,
  offset,
  text,
});

test("a chunk cannot overrun the text budget, and a later reply still arrives", async () => {
  const sent: LiveFrame[] = [];
  const batcher = liveBatcher(async (frames) => {
    sent.push(...frames);
  });
  batcher.push(frame("x".repeat(256 * 1024 - 1)));
  batcher.push(frame("yy", "reply", 256 * 1024 - 1));
  batcher.push(frame("", "empty"));
  await batcher.flush();
  expect(sent.map((f) => f.text.length)).toEqual([256 * 1024 - 1]);
  batcher.push(frame("next reply", "next"));
  await batcher.flush();
  expect(sent.at(-1)?.text).toBe("next reply");
  expect(batcher.stats().dropped).toBe(2);
});

test("distinct streams cannot grow the queue while a post is stalled", async () => {
  let unblock: (() => void) | undefined;
  let started: (() => void) | undefined;
  const posting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const sent: LiveFrame[][] = [];
  const batcher = liveBatcher(async (frames) => {
    sent.push(frames);
    if (sent.length === 1) {
      started?.();
      await blocked;
    }
  });
  batcher.push(frame("first"));
  const flushed = batcher.flush();
  await posting;
  for (let i = 0; i < 10_000; i++) batcher.push(frame("x", `reply-${i}`));
  unblock?.();
  await flushed;
  expect(sent.map((batch) => batch.length)).toEqual([1, 1000]);
  expect(batcher.stats().dropped).toBe(9000);
});
