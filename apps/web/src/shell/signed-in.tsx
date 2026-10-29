/**
 * The sign-in gate: a layout route that asks the API who is signed in, then
 * renders the feature routes under the top bar, or the sign-in screen.
 * Features read the signed-in user with `useOutletContext<Me>()`; they never
 * call `getMe` themselves. With no session, the gate asks the server for a guest
 * (`POST /api/auth/guest`); a server with guests off refuses, and the sign-in screen
 * shows. A 401 from any later call (`onSignedOut`) runs the same load again.
 */
import { ApiError, getMe, onSignedOut, startGuest } from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import { Button } from "@voluma/ui";
import { useCallback, useEffect, useState } from "react";
import { Outlet } from "react-router";
import { GateScreen, SignInScreen } from "./sign-in-screen";
import { TopBar } from "./top-bar";

type Session =
  | { state: "loading" }
  | { state: "signed-out" }
  // offline: the request never got an answer from the API; down: the API answered 5xx.
  | { state: "unreachable"; cause: "offline" | "down" }
  | { state: "signed-in"; me: Me };

export function SignedIn() {
  const [session, setSession] = useState<Session>({ state: "loading" });

  const load = useCallback(
    () =>
      getMe()
        .then((me) => me ?? startGuest())
        .then(
          (me) => setSession(me ? { state: "signed-in", me } : { state: "signed-out" }),
          (error: unknown) => {
            // TypeError: no network. SyntaxError: something other than the API
            // (a captive portal, a proxy) answered with a non-JSON page.
            if (error instanceof TypeError || error instanceof SyntaxError)
              setSession({ state: "unreachable", cause: "offline" });
            else if (error instanceof ApiError && error.status >= 500)
              setSession({ state: "unreachable", cause: "down" });
            // A schema mismatch or an unexpected status is a bug: hand it to
            // the router's error screen rather than stalling on "Loading…".
            else
              setSession(() => {
                throw error;
              });
          },
        ),
    [],
  );

  useEffect(() => {
    load();
    return onSignedOut(() => void load());
  }, [load]);

  switch (session.state) {
    case "loading":
      return (
        <main aria-busy="true" className="grid min-h-dvh place-content-center">
          {/* Shown only when loading is slow, so a fast load doesn't flash it. */}
          <p className="animate-[appear_200ms_ease-out_600ms_both] text-ui text-muted-foreground">
            Loading…
          </p>
        </main>
      );
    case "signed-out":
      return <SignInScreen onSignedIn={(me) => setSession({ state: "signed-in", me })} />;
    case "unreachable":
      return <UnreachableScreen cause={session.cause} retry={load} />;
    case "signed-in":
      return (
        // Pages fill the space under the bar and scroll inside it, so the bar stays put. `relative`
        // keeps absolutely placed content (sr-only legends) inside the scroller, not the page.
        <div className="flex h-dvh flex-col">
          <TopBar me={session.me} />
          <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
            <Outlet context={session.me} />
          </div>
        </div>
      );
  }
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
