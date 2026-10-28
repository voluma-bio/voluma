/**
 * A visitor's own keys (`VisitorKeys`): asked on the start screen and again when a run is
 * waiting for them. They stay in this browser's localStorage, which is where the contract
 * says a visitor's keys live; the server holds them in memory only.
 */
import type { VisitorKeys } from "@voluma/contracts/run";
import { Button } from "@voluma/ui";
import { type FormEvent, useState } from "react";

const STORAGE_KEY = "voluma.visitor-keys";

export function loadKeys(): VisitorKeys | undefined {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as VisitorKeys;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return undefined;
  }
}

export const saveKeys = (keys: VisitorKeys) =>
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));

const inputClass =
  "h-9 w-full rounded-lg border border-input bg-card px-3 text-ui outline-none focus-visible:border-ring";

/** Three password fields; `onSubmit` gets complete keys, which are saved first. */
export function KeysForm({
  submitLabel,
  busy,
  onSubmit,
}: {
  submitLabel: string;
  busy?: boolean;
  onSubmit: (keys: VisitorKeys) => void;
}) {
  const saved = loadKeys();
  const [metaApiKey, setMeta] = useState(saved?.metaApiKey ?? "");
  const [tokenId, setTokenId] = useState(saved?.modal.tokenId ?? "");
  const [tokenSecret, setTokenSecret] = useState(saved?.modal.tokenSecret ?? "");

  function submit(event: FormEvent) {
    event.preventDefault();
    const keys = { metaApiKey, modal: { tokenId, tokenSecret } };
    saveKeys(keys);
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
