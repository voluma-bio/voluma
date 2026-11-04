import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const worktree = "/home/jimyao/gitrepos/voluma.worktrees/p1739-timelapse";
const out = "/home/jimyao/.meridian/projects/even-kettle-circuit/sessions/c1714/work/smoke";
const events =
  "/home/jimyao/.meridian/projects/even-kettle-circuit/sessions/c1714/work/staging-dump/events.frozen.jsonl";
mkdirSync(out, { recursive: true });
const { appUrl } = JSON.parse(readFileSync(resolve(worktree, ".dev/env.json"), "utf8"));

const run = (args) =>
  new Promise((resolveP, reject) => {
    const p = spawn("pnpm", ["--filter", "@voluma/api", "replay:run", ...args], {
      cwd: worktree,
      stdio: "inherit",
    });
    p.on("exit", (code) => (code === 0 ? resolveP() : reject(new Error(`exit ${code}`))));
  });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("console", m.text());
});
await page.goto(appUrl, { waitUntil: "load" });
await page.waitForTimeout(1500);
const me = await page.evaluate(async () =>
  (await fetch("/api/auth/me", { credentials: "include" })).json(),
);
console.log("me", me);
await run(["--setup", "--replace", "--user", me.userId, "--lab", me.labId]);
console.log("playing burst");
await run(["--play", "--from", events, "--target-seconds", "8"]);
const map = JSON.parse(readFileSync(resolve(worktree, ".dev/replay.json"), "utf8"));
const url = `${appUrl}/studies/${map.localStudyId}/inputs/${map.localInputId}`;
console.log("open", url);
await page.goto(url, { waitUntil: "load", timeout: 60_000 });
await page.waitForTimeout(8000);
await page.screenshot({ path: resolve(out, "end.png") });
const labels = page.getByRole("tab", { name: "Labels" });
if (await labels.count()) {
  await labels.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: resolve(out, "labels.png") });
}
writeFileSync(resolve(out, "body.txt"), (await page.locator("body").innerText()).slice(0, 6000));
await browser.close();
console.log("done", out);
