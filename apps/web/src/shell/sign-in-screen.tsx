/**
 * The signed-out screens: plain sign-in, and the two refused-sign-in outcomes
 * the API redirects to as `/?signin=<outcome>`. `GateScreen` is their shared
 * layout, also used when the API can't be reached.
 */
import { signIn } from "@voluma/api-client";
import { signinOutcomeSchema } from "@voluma/contracts/auth";
import { Button } from "@voluma/ui";
import type { ReactNode } from "react";

// Back to this page after sign-in, without the outcome of the last attempt.
function startSignIn() {
  const url = new URL(location.href);
  url.searchParams.delete("signin");
  signIn(url.pathname + url.search);
}

export function SignInScreen() {
  const outcome = signinOutcomeSchema.safeParse(new URLSearchParams(location.search).get("signin"));
  if (outcome.data === "not-a-member")
    return (
      <GateScreen
        title="This account isn't part of a lab on Voluma yet"
        detail="Sign in with your lab account, or ask your lab to add this one."
      >
        <Button variant="primary" onClick={startSignIn}>
          Sign in with another account
        </Button>
      </GateScreen>
    );
  if (outcome.data === "failed")
    return (
      <GateScreen title="Sign-in didn't complete">
        <Button variant="primary" onClick={startSignIn}>
          Try again
        </Button>
      </GateScreen>
    );
  return (
    <GateScreen
      title="Voluma"
      detail="Turn a micro-CT scan into validated measurements, each traced to its evidence."
    >
      <Button variant="primary" onClick={startSignIn}>
        Sign in
      </Button>
      {/* "Explore the demo" goes here, as a quiet button beside Sign in. */}
    </GateScreen>
  );
}

/** The brand mark, a centred title, an optional line under it, and the user's choices. */
export function GateScreen({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="grid w-full max-w-md justify-items-center gap-6 text-center">
        <div className="grid justify-items-center gap-3">
          <BrandMark />
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {detail ? <p className="text-muted-foreground">{detail}</p> : null}
        </div>
        <div className="flex flex-wrap justify-center gap-3">{children}</div>
      </div>
    </main>
  );
}

// The mark from the mockups' top bar.
function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-9 text-primary">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M7 14c2-5 8-5 10 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
