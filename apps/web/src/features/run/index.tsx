/**
 * Run lane: the live run. Light theme. Owns its routes; the shell mounts them.
 */
import type { RouteObject } from "react-router";
import { RunPage } from "./run-page";

export const runRoutes: RouteObject[] = [{ path: "/runs/:id/live", element: <RunPage /> }];
