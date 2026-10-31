/** The caller's personal settings, mounted at /api/user; never reads another user's settings. */
import { updateUserSettingsRequestSchema } from "@voluma/contracts/settings";
import { Hono } from "hono";
import { parseJson, requireUser, type UserEnv } from "../../domain";
import type { UserSettingsStore } from "./pg-settings";

export function createUser({ settings }: { settings: UserSettingsStore }) {
  const app = new Hono<UserEnv>().use(requireUser);
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/settings", async (c) => c.json(await settings.get(c.var.user.userId)));
  app.post("/settings", async (c) => {
    const patch = await parseJson(c, updateUserSettingsRequestSchema);
    return c.json(await settings.update(c.var.user.userId, patch));
  });
  return app;
}
