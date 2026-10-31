/** Personal settings at /settings, reached through the account menu. */
import type { RouteObject } from "react-router";
import { SettingsPage } from "./settings-page";

export const settingsRoutes: RouteObject[] = [{ path: "/settings", element: <SettingsPage /> }];
