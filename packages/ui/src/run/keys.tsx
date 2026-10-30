/**
 * A visitor's own keys (`VisitorKeys`): asked on Run on new scans and again when a run is
 * waiting for them. They stay in this browser's localStorage, under the user's id so another
 * user of the browser never sees them; the server holds them in memory only.
 */
import { type VisitorKeys, visitorKeysSchema } from "@voluma/contracts/run";
import { type FormEvent, useState } from "react";
import { Button } from "../button";

const storageKey = (userId: string) => `voluma.visitor-keys.${userId}`;

/** The keys this user saved in this browser; stored text that doesn't parse is dropped. */
export function loadKeys(userId: string): VisitorKeys | undefined {
  const raw = localStorage.getItem(storageKey(userId));
  if (!raw) return undefined;
  try {
    const stored = JSON.parse(raw);
    const parsed = visitorKeysSchema.safeParse(stored);
    if (parsed.success) {
      // Keys saved when a guest also gave a Modal token: keep only the Meta key.
      if ("modal" in stored) saveKeys(userId, parsed.data);
      return parsed.data;
    }
  } catch {}
  forgetKeys(userId);
  return undefined;
}

export const saveKeys = (userId: string, keys: VisitorKeys) =>
  localStorage.setItem(storageKey(userId), JSON.stringify(keys));

export const forgetKeys = (userId: string) => localStorage.removeItem(storageKey(userId));

const inputClass =
  "h-9 w-full rounded-lg border border-input bg-card px-3 text-ui outline-none focus-visible:border-ring";

/** A password field for the Meta key; `onSubmit` gets complete keys, which are saved first. */
export function KeysForm({
  userId,
  submitLabel,
  busy,
  onSubmit,
}: {
  userId: string;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (keys: VisitorKeys) => void;
}) {
  const saved = loadKeys(userId);
  const [metaApiKey, setMeta] = useState(saved?.metaApiKey ?? "");

  function submit(event: FormEvent) {
    event.preventDefault();
    const keys = { metaApiKey };
    saveKeys(userId, keys);
    onSubmit(keys);
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <label className="grid gap-1 text-meta font-medium">
        Meta Model API key
        <input
          type="password"
          autoComplete="off"
          required
          maxLength={512}
          value={metaApiKey}
          onChange={(e) => setMeta(e.target.value)}
          className={inputClass}
        />
      </label>
      <Button type="submit" variant="primary" disabled={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}
