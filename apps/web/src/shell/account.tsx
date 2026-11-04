/**
 * The brand lockup (the sign-in screen), the header's mark, and the rail's foot: a guest's Sign in,
 * and Settings (the theme and who is signed in, with Sign in or Sign out). Settings opens by itself
 * when the location's state carries `openSettings` (the old `/settings` page redirects so).
 */

import { useQuery } from "@tanstack/react-query";
import { signIn, signOut } from "@voluma/api-client";
import { userSettingsQuery, useUpdateUserSettings } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import { Button, Popover, RailButton, SegmentedControl, volumaMarkUrl } from "@voluma/ui";
import { LogIn, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

/** The shared brand mark beside the wordmark on sign-in screens. */
export function BrandLockup({ className }: { className: string }) {
  return (
    <span className={`flex items-center font-semibold ${className}`}>
      <img src={volumaMarkUrl} alt="" width={224} height={176} className="object-contain" />
      Voluma
    </span>
  );
}

/** The header's non-interactive brand mark. */
export function BrandMark() {
  return (
    <img
      src={volumaMarkUrl}
      alt="Voluma"
      width={224}
      height={176}
      className="size-6 object-contain"
    />
  );
}

/** On the rail for a guest, so Sign in needs no hunting. */
export function RailSignIn() {
  return (
    <RailButton
      label="Sign in"
      icon={<LogIn />}
      onClick={() => signIn(location.pathname + location.search)}
    />
  );
}

export function SettingsMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const { pathname, search, state } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!(state as { openSettings?: boolean } | null)?.openSettings) return;
    setOpen(true);
    // Drop the state so a reload or Back doesn't reopen it.
    navigate(pathname + search, { replace: true, state: null });
  }, [state, pathname, search, navigate]);
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
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next && signOutState === "failed") setSignOutState("idle");
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
