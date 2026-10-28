/**
 * The sign-in gate: a layout route that asks the API who is signed in, then
 * renders the feature routes with the account menu, or the sign-in screen.
 * A 401 from any later call (`onSignedOut`) returns to the sign-in screen.
 */
import { ApiError, getMe, onSignedOut, signOut } from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import { Button } from "@voluma/ui";
import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useState } from "react";
import { Outlet } from "react-router";
import { GateScreen, SignInScreen } from "./sign-in-screen";

type Session =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "unreachable" }
  | { state: "signed-in"; me: Me };

export function SignedIn() {
  const [session, setSession] = useState<Session>({ state: "loading" });

  const load = useCallback(() => {
    setSession({ state: "loading" });
    getMe().then(
      (me) => setSession(me ? { state: "signed-in", me } : { state: "signed-out" }),
      (error: unknown) => {
        // A network failure or 5xx; a schema mismatch is a bug and should surface.
        if (error instanceof ApiError || error instanceof TypeError)
          setSession({ state: "unreachable" });
        else throw error;
      },
    );
  }, []);

  useEffect(() => {
    load();
    return onSignedOut(() => setSession({ state: "signed-out" }));
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
      return <SignInScreen />;
    case "unreachable":
      return (
        <GateScreen title="Voluma can't be reached" detail="Check your connection, then try again.">
          <Button variant="primary" onClick={load}>
            Try again
          </Button>
        </GateScreen>
      );
    case "signed-in":
      return (
        <>
          <Outlet />
          <AccountMenu me={session.me} />
        </>
      );
  }
}

// Features own their screens and there is no shared top bar yet, so the menu
// sits over the top-right corner of every screen.
function AccountMenu({ me }: { me: Me }) {
  const who = me.name ?? (me.kind === "member" ? me.email : "Demo visitor");
  const [signingOut, setSigningOut] = useState(false);
  return (
    <DropdownMenu.Root>
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
          className="z-50 min-w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-ui font-medium">{who}</p>
            {me.kind === "member" && me.name && (
              <p className="truncate text-meta text-muted-foreground">{me.email}</p>
            )}
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            disabled={signingOut}
            onSelect={() => {
              setSigningOut(true);
              signOut().catch(() => setSigningOut(false));
            }}
            className="cursor-pointer rounded-md px-2.5 py-1.5 text-ui outline-none data-disabled:opacity-50 data-highlighted:bg-accent"
          >
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
