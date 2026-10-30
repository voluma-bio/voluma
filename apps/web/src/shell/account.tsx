/** The brand mark and the account menu at the right end of the shell's header line. */
import { signIn, signOut } from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import { Button } from "@voluma/ui";
import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
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

const itemClass =
  "cursor-pointer rounded-md px-2.5 py-1.5 text-sm outline-none data-disabled:opacity-50 data-highlighted:bg-accent";

export function AccountMenu({ me }: { me: Me }) {
  const who = me.name ?? (me.kind === "member" ? me.email : "Guest");
  const [signOutState, setSignOutState] = useState<"idle" | "pending" | "failed">("idle");
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open && signOutState === "failed") setSignOutState("idle");
      }}
    >
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="sm" className="max-w-56 px-2" aria-label={`Account: ${who}`}>
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
            <p className="truncate text-sm font-medium">{who}</p>
            {me.kind === "member" && me.name && (
              <p className="truncate text-xs text-muted-foreground">{me.email}</p>
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
                <p role="alert" className="px-2.5 pt-1 pb-1.5 text-xs text-destructive">
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
