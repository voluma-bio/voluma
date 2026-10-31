/**
 * Moves an open tab onto a newly deployed web app. A deploy replaces the web app and the API
 * together, but an open tab keeps the old code: its chunks may be gone (`vite:preloadError`), or
 * an API response may have a new shape (`ContractError`). A missing chunk always means a deploy,
 * so that reloads at once. A contract mismatch reloads only once `/` names a different entry
 * bundle than the one running, rechecking for about 30 s while the deploy switches over; if it
 * never does, the mismatch is this app's own bug and its error shows. Either way a tab reloads at
 * most once toward a given bundle, so a bundle that keeps failing can't loop. The reload waits for
 * a held pointer and for work that holds it (`holdLeave`).
 */
import { type ContractError, onContractError } from "@voluma/api-client";

/** Waits before each look at `/`: checks at 0, 5, 15 and 30 s. */
const RECHECK_MS = [0, 5000, 10_000, 15_000];

/** `running`: the URL of the entry module this tab runs (`import.meta.url` in `main.tsx`). */
export function followDeploys(running: string) {
  window.addEventListener("vite:preloadError", (event) => {
    if (!claim(`voluma:preload-reload:${running}`)) return;
    event.preventDefault();
    window.location.reload();
  });

  trackPointer();
  let found = false;
  let checking: Promise<boolean> | undefined;
  // A write's mismatch sends the tab Home rather than reloading the form that made it.
  let home = false;
  // True: the failed call never settles, as the tab leaves now or after a pointer release. Under
  // a hold the leave may be long off, so the call fails instead: held work that made it can end
  // (and release its hold) rather than hang forever.
  const leavingSoon = () => holds === 0;
  onContractError((error: ContractError) => {
    home ||= error.write;
    if (found) return Promise.resolve(leavingSoon());
    checking ??= deployed(running).then((entry) => {
      checking = undefined;
      if (!entry || !claim(`voluma:deploy-reload:${entry}`)) {
        home = false;
        return false;
      }
      found = true;
      whenIdle(() => {
        if (home) window.location.assign("/");
        else window.location.reload();
      });
      return leavingSoon();
    });
    return checking;
  });
}

/** The entry bundle `/` names when it isn't `running`; undefined if it stays the same. */
async function deployed(running: string): Promise<string | undefined> {
  for (const wait of RECHECK_MS) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const res = await fetch("/", { cache: "no-store" });
      if (!res.ok) continue;
      const page = new DOMParser().parseFromString(await res.text(), "text/html");
      // In dev the page also loads Vite's client: the entry is whichever module script runs here.
      const entries = [...page.querySelectorAll('script[type="module"][src]')].map(
        (script) => new URL(script.getAttribute("src") ?? "", window.location.origin).href,
      );
      if (entries.length > 0 && !entries.includes(running)) return entries.join(" ");
    } catch {
      // Unreachable mid-deploy: look again.
    }
  }
  return undefined;
}

/** Marks `key` used in this tab; false when it already was, or storage is unavailable (never loop). */
function claim(key: string): boolean {
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");
    return true;
  } catch {
    return false;
  }
}

let holds = 0;
let pointerDown = false;
/** The leave waiting for the page to go idle: set once a deploy is found. */
let pending: (() => void) | undefined;

/**
 * Keeps the tab from leaving for a deploy while work that a reload would lose is under way (a
 * scan uploading). Returns the release; the tab leaves once the last hold is released. Release on
 * every way the work ends, unmount included, or the tab stays on the old app.
 */
export function holdLeave(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    recheck();
  };
}

/**
 * Busy: a hold is taken, or a pointer is held down in a visible tab (drawing a mark, dragging).
 * Typed text needs no wait: The AI box keeps its draft across a reload (`ai-panel.tsx`).
 */
const busy = () => holds > 0 || (pointerDown && document.visibilityState !== "hidden");

// After the event, so a release's click has run.
const recheck = () =>
  setTimeout(() => {
    if (!pending || busy()) return;
    const leave = pending;
    pending = undefined;
    leave();
  });

function trackPointer() {
  window.addEventListener("pointerdown", () => (pointerDown = true), true);
  for (const type of ["pointerup", "pointercancel"])
    window.addEventListener(
      type,
      () => {
        pointerDown = false;
        recheck();
      },
      true,
    );
  document.addEventListener("visibilitychange", recheck);
}

/** Runs `leave` now if nothing is busy, else once it isn't. */
function whenIdle(leave: () => void) {
  if (!busy()) return leave();
  pending = leave;
}
