/**
 * Record the local replay at 1440×900, light theme. Run after `pnpm dev` and
 * after events have been frozen. Playwright is installed next to this script
 * or in RECORD_PW.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const worktree = resolve(here, "../..");
const outDir =
  process.env.RECORD_OUT ||
  "/home/jimyao/.meridian/projects/even-kettle-circuit/sessions/c1092/work/timelapse";
const eventsPath = process.env.EVENTS_JSONL;
const targetSeconds = Number(process.env.TARGET_SECONDS || 100);
const envFile = resolve(worktree, ".dev/env.json");
const { appUrl } = JSON.parse(readFileSync(envFile, "utf8"));

if (!eventsPath) throw new Error("set EVENTS_JSONL");

function loadEvents(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e && e.seq && e.type)
    .sort((a, b) => a.seq - b.seq);
}

function cuesOf(events, speed) {
  const t0 = Date.parse(events[0].createdAt);
  const at = (ts) => (Date.parse(ts) - t0) / speed;
  const first = (type, test) => events.find((e) => e.type === type && (!test || test(e)));
  const scan = first("assets.ready");
  const labels = events.find(
    (e) => e.type === "output.published" && e.payload?.outputId === "bone-labels",
  );
  const labelsReady = events.find(
    (e) =>
      e.type === "assets.ready" &&
      labels &&
      Date.parse(e.createdAt) >= Date.parse(labels.createdAt),
  );
  const values = events.find(
    (e) => e.type === "output.published" && e.payload?.kind === "value" && e.payload?.value,
  );
  const agent2 = events.filter((e) => e.type === "agent.message")[2];
  return {
    t0,
    speed,
    scanMs: scan ? at(scan.createdAt) : 8_000,
    labelsMs: labelsReady
      ? at(labelsReady.createdAt)
      : at(labels?.createdAt ?? events[0].createdAt),
    valuesMs: values ? at(values.createdAt) : 70_000,
    talkMs: agent2 ? at(agent2.createdAt) : 70_000,
    endMs: at(events[events.length - 1].createdAt),
  };
}

mkdirSync(outDir, { recursive: true });
mkdirSync(resolve(outDir, "shots"), { recursive: true });

const events = loadEvents(eventsPath);
const spanMs = Date.parse(events[events.length - 1].createdAt) - Date.parse(events[0].createdAt);
const speed = spanMs / (targetSeconds * 1000);
const cues = cuesOf(events, speed);
writeFileSync(
  resolve(outDir, "cues.json"),
  `${JSON.stringify({ ...cues, spanMs, targetSeconds }, null, 2)}\n`,
);

const browser = await chromium.launch({ headless: true });
const setup = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const setupPage = await setup.newPage();
await setupPage.goto(appUrl, { waitUntil: "load" });
await setupPage.waitForTimeout(2000);
const me = await setupPage.evaluate(async () => {
  const r = await fetch("/api/auth/me", { credentials: "include" });
  return r.json();
});
if (!me?.userId) throw new Error(`not signed in: ${JSON.stringify(me)}`);
console.log(`signed in ${me.userId} lab ${me.labId}`);

const replay = spawn(
  "pnpm",
  [
    "--filter",
    "@voluma/api",
    "replay:run",
    "--setup",
    "--replace",
    "--user",
    me.userId,
    "--lab",
    me.labId,
  ],
  { cwd: worktree, stdio: "inherit" },
);
await new Promise((resolveP, reject) => {
  replay.on("exit", (code) => (code === 0 ? resolveP() : reject(new Error(`setup ${code}`))));
});
const map = JSON.parse(readFileSync(resolve(worktree, ".dev/replay.json"), "utf8"));
const sampleUrl = `${appUrl}/studies/${map.localStudyId}/inputs/${map.localInputId}`;
console.log(`sample ${sampleUrl}`);
const storage = resolve(outDir, "storage.json");
await setup.storageState({ path: storage });
await setup.close();

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: resolve(outDir, "video-raw"), size: { width: 1440, height: 900 } },
  storageState: storage,
});
const page = await context.newPage();
await page.goto(sampleUrl, { waitUntil: "load", timeout: 60_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: resolve(outDir, "shots/01-start.png") });

const play = spawn(
  "pnpm",
  [
    "--filter",
    "@voluma/api",
    "replay:run",
    "--play",
    "--ended",
    "--from",
    eventsPath,
    "--target-seconds",
    String(targetSeconds),
  ],
  { cwd: worktree, stdio: "inherit" },
);
const playDone = new Promise((resolveP, reject) => {
  play.on("exit", (code) => (code === 0 ? resolveP() : reject(new Error(`play ${code}`))));
});
const tPlay = Date.now();
const waitUntil = async (ms, extra = 0) => {
  const left = ms + extra - (Date.now() - tPlay);
  if (left > 0) await page.waitForTimeout(left);
};

await waitUntil(cues.scanMs, 4000);
await page.screenshot({ path: resolve(outDir, "shots/02-scan.png") });

await waitUntil(cues.labelsMs, 2500);
const bone = page.getByText(/^Bone labels$/i).first();
if (await bone.count()) await bone.click();
const labelsTab = page.getByRole("tab", { name: "Labels" });
if (await labelsTab.count()) await labelsTab.click();
await page.waitForTimeout(2000);
await page.screenshot({ path: resolve(outDir, "shots/03-labels.png") });

await waitUntil(cues.talkMs, 800);
const convTab = page.getByRole("tab", { name: "Conversation" });
if (await convTab.count()) await convTab.click();
await page.waitForTimeout(1000);
await page.screenshot({ path: resolve(outDir, "shots/04-conversation.png") });

await waitUntil(cues.valuesMs, 2000);
const patella = page.getByText(/Patella volume/i).first();
if (await patella.count()) await patella.click();
await page.waitForTimeout(1500);
await page.screenshot({ path: resolve(outDir, "shots/05-values.png") });

await playDone.catch((err) => console.error("play failed", err));
await waitUntil(cues.endMs, 2500);
const femur = page.getByText(/Distal femoral length/i).first();
if (await femur.count()) await femur.click();
await page.waitForTimeout(1500);
await page.screenshot({ path: resolve(outDir, "shots/06-final-outputs.png") });
await page.screenshot({ path: resolve(outDir, "shots/07-end.png") });
await page.waitForTimeout(2000);

const video = page.video();
await page.close();
const rawPath = video ? await video.path() : null;
await context.close();
await browser.close();
if (rawPath) {
  const dest = resolve(outDir, "replay.webm");
  const { copyFileSync } = await import("node:fs");
  copyFileSync(rawPath, dest);
  console.log(`video ${dest}`);
}
console.log(`shots ${resolve(outDir, "shots")}`);
console.log(`cues speed=${speed.toFixed(1)}x end=${(cues.endMs / 1000).toFixed(1)}s`);
