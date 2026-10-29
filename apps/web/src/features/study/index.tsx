/**
 * Study lane: a study's dashboard (`/studies/:id`), with the query client its screens share.
 * Light theme. Owns its routes; the shell mounts them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me } from "@voluma/contracts/auth";
import { Outlet, type RouteObject, useOutletContext } from "react-router";
import { StudyPage } from "./study-page/study-page";

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
    children: [{ path: "/studies/:id", element: <StudyPage /> }],
  },
];
