/**
 * The brand lockup (the sign-in screen), the rail's mark, and Settings at the rail's foot: the
 * theme and who is signed in, with Sign in or Sign out.
 */

import { useQuery } from "@tanstack/react-query";
import { signIn, signOut } from "@voluma/api-client";
import { userSettingsQuery, useUpdateUserSettings } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import { Button, Popover, RailButton, SegmentedControl } from "@voluma/ui";
import { Settings } from "lucide-react";
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

/** The rail's 24 px mark: the wordmark's initial, since the face mark never appears alone. */
export function RailMark() {
  return (
    <span className="grid size-6 place-items-center rounded-md bg-primary font-semibold text-primary-foreground text-sm">
      V
    </span>
  );
}

export function SettingsMenu({ me }: { me: Me }) {
  const who = me.name ?? (me.kind === "member" ? me.email : "Guest");
  const settings = useQuery(userSettingsQuery(me.userId));
  const save = useUpdateUserSettings(me.userId);
  const [signOutState, setSignOutState] = useState<"idle" | "pending" | "failed">("idle");
  return (
    <Popover
      side="right"
      align="end"
      label="Settings"
      className="w-64 p-3"
      onOpenChange={(open) => {
        if (!open && signOutState === "failed") setSignOutState("idle");
      }}
      trigger={<RailButton label="Settings" icon={<Settings />} />}
    >
      <p className="m-0 mb-1.5 text-muted-foreground text-sm">Theme</p>
      {settings.data ? (
        <SegmentedControl
          label="Theme"
          value={settings.data.theme}
          onValueChange={(theme) => {
            if (!save.isPending) save.mutate({ theme });
          }}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      ) : (
        <p className="m-0 text-muted-foreground text-sm">
          {settings.isError ? "Couldn't load your theme." : "Loading…"}
        </p>
      )}
      {save.isError && (
        <p role="alert" className="m-0 mt-1.5 text-destructive text-xs">
          Couldn't save your theme. Choose it again to retry.
        </p>
      )}
      <div className="mt-4">
        <p className="m-0 truncate font-medium text-sm">{who}</p>
        {me.kind === "member" && me.name && (
          <p className="m-0 truncate text-muted-foreground text-xs">{me.email}</p>
        )}
        {me.kind === "visitor" ? (
          <Button
            size="sm"
            className="mt-2"
            onClick={() => signIn(location.pathname + location.search)}
          >
            Sign in
          </Button>
        ) : (
          <Button
            size="sm"
            className="mt-2"
            disabled={signOutState === "pending"}
            onClick={() => {
              setSignOutState("pending");
              signOut().catch(() => setSignOutState("failed"));
            }}
          >
            {signOutState === "pending" ? "Signing out…" : "Sign out"}
          </Button>
        )}
        {signOutState === "failed" && (
          <p role="alert" className="m-0 mt-1.5 text-destructive text-xs">
            Couldn't sign out. Try again.
          </p>
        )}
      </div>
    </Popover>
  );
}
