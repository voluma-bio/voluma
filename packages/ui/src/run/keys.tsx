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
    const parsed = visitorKeysSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {}
  forgetKeys(userId);
  return undefined;
}

export const saveKeys = (userId: string, keys: VisitorKeys) =>
  localStorage.setItem(storageKey(userId), JSON.stringify(keys));

export const forgetKeys = (userId: string) => localStorage.removeItem(storageKey(userId));

const inputClass =
  "h-9 w-full rounded-lg border border-input bg-card px-3 text-ui outline-none focus-visible:border-ring";

/** Three password fields; `onSubmit` gets complete keys, which are saved first. */
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
  const [tokenId, setTokenId] = useState(saved?.modal.tokenId ?? "");
  const [tokenSecret, setTokenSecret] = useState(saved?.modal.tokenSecret ?? "");

  function submit(event: FormEvent) {
    event.preventDefault();
    const keys = { metaApiKey, modal: { tokenId, tokenSecret } };
    saveKeys(userId, keys);
    onSubmit(keys);
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      {[
        ["Meta Model API key", metaApiKey, setMeta],
        ["Modal token ID", tokenId, setTokenId],
        ["Modal token secret", tokenSecret, setTokenSecret],
      ].map(([label, value, set]) => (
        <label key={label as string} className="grid gap-1 text-meta font-medium">
          {label as string}
          <input
            type="password"
            autoComplete="off"
            required
            maxLength={512}
            value={value as string}
            onChange={(e) => (set as (v: string) => void)(e.target.value)}
            className={inputClass}
          />
        </label>
      ))}
      <Button type="submit" variant="primary" disabled={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}
