/** Releasing a thread destroys only the sandbox it held when it ended, never the one a resume made. */
import { expect, test } from "vitest";
import type { Sandbox } from "./ports/sandbox";
import { sandboxSession } from "./sandbox-session";

test("a get during a release's slow destroy gets a sandbox the release leaves alone", async () => {
  const destroyed: number[] = [];
  let made = 0;
  const create = async (): Promise<Sandbox> => {
    const n = ++made;
    return {
      exitCode: async () => (destroyed.includes(n) ? 0 : null),
      destroy: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        destroyed.push(n);
      },
      exec: async function* () {},
      writeFile: async () => {},
    };
  };
  const session = sandboxSession(
    create,
    () => {},
    () => "restarted",
  );
  await session.get("t");
  const releasing = session.release("t");
  const second = await session.get("t");
  await releasing;
  expect(made).toBe(2);
  expect(destroyed).toEqual([1]);
  expect(await second.exitCode()).toBeNull();
  await session.close();
  expect(destroyed).toEqual([1, 2]);
});
