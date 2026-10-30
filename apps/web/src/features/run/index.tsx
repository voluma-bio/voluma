/**
 * Run lane: the live run, with its query client. Light theme. Owns its routes; the shell mounts them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me } from "@voluma/contracts/auth";
import { Outlet, type RouteObject, useOutletContext } from "react-router";
import { RunPage } from "./run-page";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function RunLayout() {
  // Passed through: the shell's sign-in gate provides the signed-in user as outlet context.
  const me = useOutletContext<Me>();
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet context={me} />
    </QueryClientProvider>
  );
}

export const runRoutes: RouteObject[] = [
  {
    element: <RunLayout />,
    children: [{ path: "/runs/:id/live", element: <RunPage /> }],
  },
];
