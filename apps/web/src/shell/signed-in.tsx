/**
 * The sign-in gate: a layout route that asks the API who is signed in, then
 * renders the feature routes inside the app shell, or the sign-in screen. It also
 * owns the one query client every feature shares, so a change in one screen (an
 * item checked in the review) refreshes the others (the study's counts).
 * Features read the signed-in user with `useOutletContext<Me>()`; they never
 * call `getMe` themselves. With no session, the gate asks the server for a guest
 * (`POST /api/auth/guest`); a server with guests off refuses, and the sign-in screen
 * shows. A 401 drops the authenticated tree; returning to the tab rechecks identity,
 * since another tab can replace the cookie without a 401.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, getMe, onSignedOut, startGuest } from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import { AppShell, Button, LoadingState, ShellLink } from "@voluma/ui";
import { House, Workflow } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { AccountMenu, BrandLockup } from "./account";
import { GateScreen, SignInScreen } from "./sign-in-screen";

type Session =
  | { state: "loading" }
  | { state: "signed-out" }
  // offline: the request never got an answer from the API; down: the API answered 5xx.
  | { state: "unreachable"; cause: "offline" | "down" }
  | { state: "signed-in"; me: Me };

export function SignedIn() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const request = useRef(0);
  const pendingGuest = useRef<Promise<Me | null> | null>(null);

  const load = useCallback(async () => {
    const current = ++request.current;
    try {
      // A superseded guest response still writes its cookie. Wait even if it fails,
      // then read the browser's resulting identity instead of racing another mint.
      await pendingGuest.current?.catch(() => {});
      if (current !== request.current) return;
      let me = await getMe();
      if (current !== request.current) return;
      if (!me) {
        pendingGuest.current = startGuest().finally(() => {
          pendingGuest.current = null;
        });
        me = await pendingGuest.current;
      }
      if (current !== request.current) return;
      setSession(me ? { state: "signed-in", me } : { state: "signed-out" });
    } catch (error) {
      if (current !== request.current) return;
      // TypeError: no network. SyntaxError: a captive portal or proxy answered with non-JSON.
      if (error instanceof TypeError || error instanceof SyntaxError)
        setSession({ state: "unreachable", cause: "offline" });
      else if (error instanceof ApiError && error.status >= 500)
        setSession({ state: "unreachable", cause: "down" });
      // Schema mismatches and unexpected statuses belong on the router's error screen.
      else
        setSession(() => {
          throw error;
        });
    }
  }, []);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") void load();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        ++request.current;
      } else onFocus();
    };
    void load();
    const unsubscribe = onSignedOut(() => {
      setSession({ state: "loading" });
      void load();
    });
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      ++request.current;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  switch (session.state) {
    case "loading":
      return (
        <main aria-busy="true" className="grid min-h-dvh place-content-center">
          <LoadingState rows={2} className="w-72" />
        </main>
      );
    case "signed-out":
      return <SignInScreen />;
    case "unreachable":
      return <UnreachableScreen cause={session.cause} retry={load} />;
    case "signed-in":
      return (
        <Shell
          key={JSON.stringify([session.me.kind, session.me.labId, session.me.userId])}
          me={session.me}
        />
      );
  }
}

function Shell({ me }: { me: Me }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  useEffect(() => () => queryClient.clear(), [queryClient]);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell
        theme="light"
        logo={
          <Link to="/" className="rounded-md">
            <BrandLockup className="gap-2 [&_svg]:size-5" />
          </Link>
        }
        account={<AccountMenu me={me} />}
      >
        <ShellLink
          id="home"
          group="app"
          label="Home"
          icon={<House />}
          active={pathname === "/"}
          go={() => navigate("/")}
        />
        <ShellLink
          id="workflows"
          group="app"
          label="Workflows"
          icon={<Workflow />}
          active={pathname === "/workflows"}
          go={() => navigate("/workflows")}
        />
        <Outlet context={me} />
      </AppShell>
    </QueryClientProvider>
  );
}

// Stays up while a retry runs, so a retry that fails again doesn't flicker.
function UnreachableScreen({
  cause,
  retry,
}: {
  cause: "offline" | "down";
  retry: () => Promise<void>;
}) {
  const [trying, setTrying] = useState(false);
  return (
    <GateScreen
      title={cause === "offline" ? "Voluma can't be reached" : "Voluma isn't responding"}
      detail={
        cause === "offline" ? "Check your connection, then try again." : "Try again in a minute."
      }
    >
      <Button
        variant="primary"
        disabled={trying}
        onClick={() => {
          setTrying(true);
          retry().finally(() => setTrying(false));
        }}
      >
        {trying ? "Trying…" : "Try again"}
      </Button>
    </GateScreen>
  );
}
