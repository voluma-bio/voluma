/**
 * The sign-in gate: a layout route that asks the API who is signed in, then
 * renders the feature routes with the account menu, or the sign-in screen.
 * Features read the signed-in user with `useOutletContext<Me>()`; they never
 * call `getMe` themselves. With no session, the gate asks the server for a guest
 * (`POST /api/auth/guest`); a server with guests off refuses, and the sign-in screen
 * shows. A 401 from any later call (`onSignedOut`) runs the same load again.
 */
import { ApiError, getMe, onSignedOut, signIn, signOut } from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import { Button } from "@voluma/ui";
import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useState } from "react";
import { Outlet } from "react-router";
import { startGuest } from "./guest";
import { GateScreen, SignInScreen } from "./sign-in-screen";

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
        <>
          <Outlet context={session.me} />
          <AccountMenu me={session.me} />
        </>
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

const itemClass =
  "cursor-pointer rounded-md px-2.5 py-1.5 text-ui outline-none data-disabled:opacity-50 data-highlighted:bg-accent";

// Features own their screens and there is no shared top bar yet, so the menu
// sits over the top-right corner of every screen.
function AccountMenu({ me }: { me: Me }) {
  const who = me.name ?? (me.kind === "member" ? me.email : "Guest");
  const [signOutState, setSignOutState] = useState<"idle" | "pending" | "failed">("idle");
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open && signOutState === "failed") setSignOutState("idle");
      }}
    >
      <DropdownMenu.Trigger asChild>
        <Button
          variant="quiet"
          size="sm"
          className="fixed top-2.5 right-3 z-30 max-w-56 px-2.5"
          aria-label={`Account: ${who}`}
        >
          <span className="truncate">{who}</span>
          <ChevronDown size={14} aria-hidden="true" className="shrink-0" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-56 max-w-72 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-ui font-medium">{who}</p>
            {me.kind === "member" && me.name && (
              <p className="truncate text-meta text-muted-foreground">{me.email}</p>
            )}
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {me.kind === "visitor" ? (
            <DropdownMenu.Item
              onSelect={() => signIn(location.pathname + location.search)}
              className={itemClass}
            >
              Sign in
            </DropdownMenu.Item>
          ) : (
            <>
              <DropdownMenu.Item
                disabled={signOutState === "pending"}
                onSelect={(event) => {
                  // Keep the menu open, so a failure has somewhere to show.
                  event.preventDefault();
                  setSignOutState("pending");
                  signOut().catch(() => setSignOutState("failed"));
                }}
                className={itemClass}
              >
                {signOutState === "pending" ? "Signing out…" : "Sign out"}
              </DropdownMenu.Item>
              {signOutState === "failed" && (
                <p role="alert" className="px-2.5 pt-1 pb-1.5 text-meta text-destructive">
                  Couldn't sign out. Try again.
                </p>
              )}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
