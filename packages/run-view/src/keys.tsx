/**
 * A user's own keys (`OwnKeys`): a Meta key and a Modal token, entered in the rail's Settings
 * (`KeysForm`). They stay in this browser's localStorage, under the user's id so another user of
 * the browser never sees them, and go to the server only when a run starts or a finished own-key
 * run is reopened; the server seals them in the database only while the run lives. Start and
 * reopen surfaces only say whose keys the run uses (`RunKeyLine`) and read the saved keys live
 * (`useSavedKeys`), so a save in Settings shows at once.
 */
import { type OwnKeys, ownKeysSchema, type Run } from "@voluma/contracts/run";
import { Button } from "@voluma/ui";
import { type FormEvent, useMemo, useState, useSyncExternalStore } from "react";

// The name keeps "visitor" on purpose: renaming the key drops every user's saved keys.
const storageKey = (userId: string) => `voluma.visitor-keys.${userId}`;
// `storage` fires only in other tabs; this one tells this tab's readers.
const changed = "voluma-keys-changed";

function parseKeys(raw: string | null): OwnKeys | undefined {
  if (!raw) return undefined;
  try {
    const parsed = ownKeysSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {}
  return undefined;
}

/** The keys this user saved in this browser; stored text that doesn't parse is dropped. */
export function loadKeys(userId: string): OwnKeys | undefined {
  const raw = localStorage.getItem(storageKey(userId));
  const keys = parseKeys(raw);
  if (raw && !keys) forgetKeys(userId);
  return keys;
}

/** `loadKeys`, kept current as keys are saved or removed in this tab or another. */
export function useSavedKeys(userId: string): OwnKeys | undefined {
  const raw = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("storage", onChange);
      window.addEventListener(changed, onChange);
      return () => {
        window.removeEventListener("storage", onChange);
        window.removeEventListener(changed, onChange);
      };
    },
    () => localStorage.getItem(storageKey(userId)),
  );
  return useMemo(() => parseKeys(raw), [raw]);
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

function saveKeys(userId: string, keys: OwnKeys) {
  localStorage.setItem(storageKey(userId), JSON.stringify(keys));
  window.dispatchEvent(new Event(changed));
}

function forgetKeys(userId: string) {
  localStorage.removeItem(storageKey(userId));
  window.dispatchEvent(new Event(changed));
}

/** Whether a start from this account can go: a guest needs both keys. */
export function canStart(volumaKey: boolean, keys: OwnKeys | undefined): boolean {
  return volumaKey || !!keys?.modal;
}

/** What runs use, in the words `RunKeyLine` and Settings share. */
function whoseKeys(volumaKey: boolean, keys: OwnKeys | undefined): string {
  if (keys?.modal) return "Runs on your Meta key and Modal account.";
  if (keys && volumaKey) return "Runs on your Meta key and Voluma's Modal account.";
  if (volumaKey) return "Runs on Voluma's keys.";
  return "Add your Meta key and Modal token in Settings to run.";
}

const inputClass =
  "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-ui outline-none focus-visible:border-ring";

function KeyField({
  label,
  value,
  required,
  onChange,
}: {
  label: string;
  value: string;
  required: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-meta font-medium">
      {label}
      <input
        type="password"
        autoComplete="off"
        required={required}
        maxLength={512}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      />
    </label>
  );
}

/**
 * Settings' API keys: whose keys runs use, then the form to save or replace them and Remove.
 * A guest must give the Meta key and the Modal token; a member may give a Meta key alone, or both.
 */
export function KeysForm({ userId, volumaKey }: { userId: string; volumaKey: boolean }) {
  const saved = useSavedKeys(userId);
  const [editing, setEditing] = useState(false);
  const [metaApiKey, setMeta] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  const modalRequired = !volumaKey || tokenId !== "" || tokenSecret !== "";

  function submit(event: FormEvent) {
    event.preventDefault();
    saveKeys(userId, {
      metaApiKey,
      ...(tokenId && tokenSecret && { modal: { tokenId, tokenSecret } }),
    });
    setMeta("");
    setTokenId("");
    setTokenSecret("");
    setEditing(false);
  }

  const status = (
    <p className="m-0 text-sm">
      {canStart(volumaKey, saved)
        ? whoseKeys(volumaKey, saved)
        : "Runs need your Meta key and Modal token."}
    </p>
  );
  const where = (
    <p className="m-0 text-muted-foreground text-xs">
      Kept in this browser only. Voluma gets them when a run starts and keeps them only while it
      runs.
    </p>
  );

  if (saved && !editing)
    return (
      <div className="grid gap-2">
        {status}
        {where}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setEditing(true)}>
            Replace keys
          </Button>
          <Button size="sm" variant="ghost" onClick={() => forgetKeys(userId)}>
            Remove
          </Button>
        </div>
      </div>
    );

  return (
    <form onSubmit={submit} className="grid gap-2">
      {status}
      <KeyField label="Meta API key" value={metaApiKey} required onChange={setMeta} />
      <KeyField
        label={modalRequired ? "Modal token ID" : "Modal token ID (optional)"}
        value={tokenId}
        required={modalRequired}
        onChange={setTokenId}
      />
      <KeyField
        label={modalRequired ? "Modal token secret" : "Modal token secret (optional)"}
        value={tokenSecret}
        required={modalRequired}
        onChange={setTokenSecret}
      />
      {where}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary">
          Save keys
        </Button>
        {editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** Next to a Start button: whose keys the run uses, and a link to Settings to change them. */
export function RunKeyLine({
  volumaKey,
  keys,
  onOpenSettings,
}: {
  /** Whether the account has Voluma's key; without it the run needs both of the user's keys. */
  volumaKey: boolean;
  keys: OwnKeys | undefined;
  onOpenSettings: () => void;
}) {
  return (
    <p className="text-ui text-muted-foreground">
      {whoseKeys(volumaKey, keys)}{" "}
      <button type="button" className="text-primary-text underline" onClick={onOpenSettings}>
        {canStart(volumaKey, keys) && !keys ? "Use your own keys" : "Open Settings"}
      </button>
    </p>
  );
}
