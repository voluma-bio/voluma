/**
 * Study feature: Home (`/`), Run on new scans (`/new`) and Workflows (`/workflows`), with the
 * query client they share. Light theme. Owns its routes; the shell mounts them. The study page
 * (`/studies/:id`) joins these routes when it lands.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me } from "@voluma/contracts/auth";
import { Outlet, type RouteObject, useOutletContext } from "react-router";
import { HomePage } from "./home-page";
import { NewPage } from "./new-page";
import { WorkflowsPage } from "./workflows-page";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function StudyLayout() {
  // Passed through: the shell's sign-in gate provides the signed-in user as outlet context.
  const me = useOutletContext<Me>();
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet context={me} />
    </QueryClientProvider>
  );
}

export const studyRoutes: RouteObject[] = [
  {
    element: <StudyLayout />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/new", element: <NewPage /> },
      { path: "/workflows", element: <WorkflowsPage /> },
    ],
  },
];
