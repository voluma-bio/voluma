/** The brand mark and the account menu at the right end of the shell's header line. */
import { signIn, signOut } from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import { Button, Menu, MenuHeader, MenuItem, MenuSeparator } from "@voluma/ui";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

// The mark beside the wordmark, as in the mockups' top bar. The mark alone
// reads as a face at large sizes, so it never appears without the wordmark.
export function BrandLockup({ className }: { className: string }) {
  return (
    <span className={`flex items-center font-semibold ${className}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="text-primary">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M7 14c2-5 8-5 10 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
      Voluma
    </span>
  );
}

export function AccountMenu({ me }: { me: Me }) {
  const who = me.name ?? (me.kind === "member" ? me.email : "Guest");
  const [signOutState, setSignOutState] = useState<"idle" | "pending" | "failed">("idle");
  return (
    <Menu
      onOpenChange={(open) => {
        if (!open && signOutState === "failed") setSignOutState("idle");
      }}
      trigger={
        <Button variant="ghost" size="sm" className="max-w-56 px-2" aria-label={`Account: ${who}`}>
          <span className="truncate">{who}</span>
          <ChevronDown aria-hidden="true" className="shrink-0" />
        </Button>
      }
    >
      <MenuHeader>
        <p className="truncate text-sm font-medium">{who}</p>
        {me.kind === "member" && me.name && (
          <p className="truncate text-xs text-muted-foreground">{me.email}</p>
        )}
      </MenuHeader>
      <MenuSeparator />
      {me.kind === "visitor" ? (
        <MenuItem onSelect={() => signIn(location.pathname + location.search)}>Sign in</MenuItem>
      ) : (
        <>
          <MenuItem
            disabled={signOutState === "pending"}
            onSelect={(event) => {
              // Keep the menu open, so a failure has somewhere to show.
              event.preventDefault();
              setSignOutState("pending");
              signOut().catch(() => setSignOutState("failed"));
            }}
          >
            {signOutState === "pending" ? "Signing out…" : "Sign out"}
          </MenuItem>
          {signOutState === "failed" && (
            <p role="alert" className="px-2 pt-1 pb-1.5 text-xs text-destructive">
              Couldn't sign out. Try again.
            </p>
          )}
        </>
      )}
    </Menu>
  );
}
