/**
 * A user's own keys (`OwnKeys`): asked on Run on new inputs, when a run is waiting for them,
 * and to reopen a finished own-key run. They stay in this browser's localStorage, under the user's
 * id so another user of the browser never sees them; the server seals them in the database only
 * while the run lives.
 */
import { type OwnKeys, ownKeysSchema, type Run } from "@voluma/contracts/run";
import { Button } from "@voluma/ui";
import { type FormEvent, useState } from "react";

const storageKey = (userId: string) => `voluma.visitor-keys.${userId}`;

/** The keys this user saved in this browser; stored text that doesn't parse is dropped. */
export function loadKeys(userId: string): OwnKeys | undefined {
  const raw = localStorage.getItem(storageKey(userId));
  if (!raw) return undefined;
  try {
    const stored = JSON.parse(raw);
    const parsed = ownKeysSchema.safeParse(stored);
    if (parsed.success) {
      // Keys saved when a guest also gave a Modal token: keep only the Meta key.
      if ("modal" in stored) saveKeys(userId, parsed.data);
      return parsed.data;
    }
  } catch {}
  forgetKeys(userId);
  return undefined;
}

/**
 * The saved keys a message or answer to this run carries: a finished own-key run was wiped of its
 * keys, so reopening it takes them again. Any other send carries none.
 */
export function keysToReopen(
  userId: string,
  run: { credentials: Run["credentials"]; state: { status: string } },
): OwnKeys | undefined {
  return run.credentials !== "voluma" && run.state.status === "ended"
    ? loadKeys(userId)
    : undefined;
}

const saveKeys = (userId: string, keys: OwnKeys) =>
  localStorage.setItem(storageKey(userId), JSON.stringify(keys));

const forgetKeys = (userId: string) => localStorage.removeItem(storageKey(userId));

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
  onSubmit: (keys: OwnKeys) => void;
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
        Meta API key
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

/**
 * Next to a Start button: whose key the run uses, from the key stored in this browser. With
 * a key it can be removed; without one an account with Voluma's key can add one, and one without must (the form).
 */
export function RunKeyLine({
  userId,
  volumaKey,
  keys,
  onChange,
}: {
  userId: string;
  /** Whether the account has Voluma's key; without it the form is required. */
  volumaKey: boolean;
  keys: OwnKeys | undefined;
  onChange: (keys: OwnKeys | undefined) => void;
}) {
  const [adding, setAdding] = useState(false);
  const link = "text-primary-text underline";
  return (
    <div className="grid max-w-sm gap-2 text-ui text-muted-foreground">
      {keys ? (
        <p>
          Runs on your Meta key.{" "}
          <button
            type="button"
            className={link}
            onClick={() => {
              forgetKeys(userId);
              onChange(undefined);
            }}
          >
            Remove it
          </button>
          .
        </p>
      ) : !volumaKey ? (
        <>
          <p>Runs on your Meta key.</p>
          <KeysForm userId={userId} submitLabel="Save key" onSubmit={onChange} />
        </>
      ) : adding ? (
        <KeysForm
          userId={userId}
          submitLabel="Save key"
          onSubmit={(k) => {
            setAdding(false);
            onChange(k);
          }}
        />
      ) : (
        <p>
          Runs on Voluma's keys.{" "}
          <button type="button" className={link} onClick={() => setAdding(true)}>
            Use your own Meta key
          </button>
          .
        </p>
      )}
    </div>
  );
}
