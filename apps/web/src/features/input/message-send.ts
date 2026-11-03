/**
 * Sending a message to a run's main AI (`use-main-message.ts` supplies its fields and its refusal
 * words): this owns the draft kept across reloads, the picture fitted into the room the body leaves, and a send
 * that keeps the message id across retries. The API deduplicates by id alone, so a retry resends
 * the exact request, picture included, and the message is stored once.
 */
import { useMutation } from "@tanstack/react-query";
import { ApiError, sendRunMessage } from "@voluma/api-client";
import {
  MAX_MESSAGE_SNAPSHOT_BYTES,
  MESSAGE_BODY_BYTES,
  type SendRunMessageRequest,
  type SendRunMessageResponse,
} from "@voluma/contracts/messages";
import { useEffect, useRef, useState } from "react";

/**
 * The box's text, kept in this tab's sessionStorage so a reload (by hand, or onto a new deploy)
 * keeps it. A send clears the box and with it the draft.
 */
export function useDraft(key: string) {
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(key, text);
      else sessionStorage.removeItem(key);
    } catch {
      // Without storage the draft lives only as long as the page.
    }
  }, [key, text]);
  return [text, setText] as const;
}

/** A message that must not go yet, in words for the researcher; its words stay in the box. */
export class NotSent extends Error {}

/**
 * Why a send failed: the reason a `NotSent` gives, the API's own words when it gave some, else
 * `byStatus`'s for the status, else a plain retry.
 */
export function refusalOf(error: Error, byStatus: (status: number) => string | undefined): string {
  if (error instanceof NotSent) return error.message;
  if (!(error instanceof ApiError)) return "Couldn't send. Check your connection and try again.";
  if (error.serverMessage) return error.serverMessage;
  return byStatus(error.status) ?? "Couldn't send. Try again.";
}

/** PNG bytes as plain base64, as the message takes them. */
async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** A message as its composer builds it, once per new message. */
export type Outgoing<M> = {
  fields: Omit<SendRunMessageRequest, "id" | "snapshot">;
  /**
   * The views as a PNG of at most this many bytes: null when even the smallest is larger. Absent,
   * no picture goes.
   */
  picture?: (maxBytes: number) => Promise<Blob | null | undefined>;
  /** The composer's own record of the message, given back with the outcome. */
  meta: M;
};

type Attempt<M> = {
  fingerprint: string;
  meta: M;
  prepared: Promise<{ body: SendRunMessageRequest; unseen: boolean }>;
};

export function useIdempotentSend<M>({
  runId,
  before,
  onSuccess,
}: {
  runId: string;
  /** Awaited on every try, before the post; a `NotSent` keeps the message unsent. */
  before?: (meta: M) => Promise<void>;
  /** `unseen`: the picture the message meant to carry couldn't be made, or was too large. */
  onSuccess: (sent: { response: SendRunMessageResponse; unseen: boolean; meta: M }) => void;
}) {
  const tried = useRef<Attempt<M>>(undefined);
  const inFlight = useRef(false);
  const send = useMutation({
    mutationFn: async (attempt: Attempt<M>) => {
      const { body, unseen } = await attempt.prepared;
      await before?.(attempt.meta);
      return { response: await sendRunMessage(runId, body), unseen, meta: attempt.meta };
    },
    onSuccess: (sent) => {
      tried.current = undefined;
      onSuccess(sent);
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  /**
   * Sends a message, unless one is on its way. `fingerprint` is everything that makes it this
   * message: the same one as the last failed try resends that request; a new one runs `make`.
   */
  const submit = (fingerprint: string, make: () => Outgoing<M>) => {
    if (inFlight.current) return;
    if (tried.current?.fingerprint !== fingerprint) {
      const { fields, picture, meta } = make();
      const body: SendRunMessageRequest = { id: crypto.randomUUID(), ...fields };
      // The picture goes in the room the rest of the body leaves (base64 is 4 bytes per 3, plus
      // the field's own JSON).
      const room = Math.floor(
        ((MESSAGE_BODY_BYTES - new Blob([JSON.stringify(body)]).size - 64) * 3) / 4,
      );
      // Taken now, not in the mutation: one can pause offline while the researcher moves on. A
      // capture that fails sends the message without its picture, and says so.
      const png: Promise<string | null | undefined> = !picture
        ? Promise.resolve(undefined)
        : room > 0
          ? picture(Math.min(MAX_MESSAGE_SNAPSHOT_BYTES, room))
              .then((blob) => blob && base64(blob))
              .catch(() => null)
          : Promise.resolve(null);
      tried.current = {
        fingerprint,
        meta,
        prepared: png.then((data) => ({
          body: { ...body, ...(data && { snapshot: { mimeType: "image/png" as const, data } }) },
          unseen: data === null,
        })),
      };
    }
    inFlight.current = true;
    send.mutate(tried.current);
  };
  return { send, submit };
}
