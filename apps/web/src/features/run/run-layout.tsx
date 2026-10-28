/** The run lane's frame: a top bar (Workflows, Runs) over the screen, and the query client its screens share. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me } from "@voluma/contracts/auth";
import { CircleCheck } from "lucide-react";
import { NavLink, Outlet, useOutletContext } from "react-router";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const link = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`;

export function RunLayout() {
  // Passed through: the shell's sign-in gate provides the signed-in user as outlet context.
  const me = useOutletContext<Me>();
  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex h-dvh flex-col max-[1100px]:h-auto max-[1100px]:min-h-dvh">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-5 pr-48">
          <span className="mr-4 flex items-center gap-2 font-semibold">
            <CircleCheck size={20} className="text-primary" aria-hidden="true" />
            Voluma
          </span>
          <NavLink to="/" end className={link}>
            Workflows
          </NavLink>
          <NavLink to="/runs" className={link}>
            Runs
          </NavLink>
        </header>
        <Outlet context={me} />
      </div>
    </QueryClientProvider>
  );
}
