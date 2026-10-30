/**
 * Lossless H.264 of a slice stack through `ffmpeg` (default quality moves the masks; the slices
 * are the frames, so frame `n` is slice `n`). yuv420p wants even sides, so an odd stack gets a
 * black edge; the boxes keep their coordinates and the prompt carries the padded size. The
 * child's exit is one promise with its handlers attached before the first write, and every wait
 * on the pipe races it, so a missing or dying ffmpeg rejects this call instead of hanging it.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { type Axis, type Box, dimsOf, eachFrame, sliceAxes } from "./geometry";

export async function encode(
  region: { box: Box; data: Uint8Array },
  crop: Box,
  axis: Axis,
  path: string,
): Promise<{ width: number; height: number }> {
  const [ra, ca] = sliceAxes(axis);
  const cd = dimsOf(crop.lo, crop.hi);
  const [height, width] = [cd[ra], cd[ca]];
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${width}x${height}`],
      ...["-r", "25", "-i", "-", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264"],
      ...["-qp", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path],
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  ffmpeg.stderr.on("data", (d) => {
    stderr += d;
  });
  ffmpeg.stdin.on("error", () => {}); // the exit promise reports a dead ffmpeg
  const exited = new Promise<number>((resolve, reject) => {
    ffmpeg.once("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ENOENT" ? new Error("ffmpeg is not installed in the sandbox") : e),
    );
    ffmpeg.once("close", (code) => resolve(code ?? -1));
  });
  let code: number | undefined;
  exited.then(
    (c) => {
      code = c;
    },
    () => {},
  );
  try {
    await eachFrame(region, crop, axis, async (frame) => {
      if (code !== undefined) return false;
      // The frame buffer is reused, so hand ffmpeg a copy it may keep queued.
      if (!ffmpeg.stdin.write(Buffer.from(frame))) {
        await Promise.race([once(ffmpeg.stdin, "drain").catch(() => {}), exited]);
      }
      return true;
    });
    ffmpeg.stdin.end();
    code = await exited;
  } catch (error) {
    ffmpeg.kill();
    throw error;
  }
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.slice(0, 500)}`);
  return { width: width + (width % 2), height: height + (height % 2) };
}
