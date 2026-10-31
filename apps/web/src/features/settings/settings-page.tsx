/** Personal appearance preferences; the shell applies the same saved query to every page. */
import { useQuery } from "@tanstack/react-query";
import { userSettingsQuery, useUpdateUserSettings } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import { Breadcrumb, ErrorState, LoadingState, PageHead, ShellHeading } from "@voluma/ui";
import { Check } from "lucide-react";
import { useOutletContext } from "react-router";
import darkPreview from "./theme-dark.webp";
import lightPreview from "./theme-light.webp";

export function SettingsPage() {
  const me = useOutletContext<Me>();
  const settings = useQuery(userSettingsQuery(me.userId));
  const save = useUpdateUserSettings(me.userId);

  return (
    <div className="shrink-0">
      <ShellHeading>
        <Breadcrumb current="Settings" />
      </ShellHeading>
      <PageHead title="Settings" />
      <section aria-labelledby="appearance-heading" className="max-w-4xl px-6 py-6">
        <h2 id="appearance-heading" className="m-0 text-base font-semibold">
          Appearance
        </h2>
        {settings.isError && (
          <ErrorState
            className="mt-3"
            title={settings.data ? "Couldn't refresh your settings" : "Couldn't load your settings"}
            onRetry={() => void settings.refetch()}
          >
            Check your connection, then try again.
          </ErrorState>
        )}
        {!settings.data && settings.isPending && (
          <LoadingState label="Loading your settings" rows={1} className="mt-3" />
        )}
        {settings.data && (
          <>
            <fieldset
              aria-disabled={save.isPending}
              aria-busy={save.isPending}
              className="m-0 mt-3 min-w-0 border-0 border-t border-border p-0 py-5 aria-busy:opacity-60"
            >
              <legend className="sr-only">Theme</legend>
              <div className="flex flex-wrap items-center justify-between gap-6">
                <div>
                  <p className="m-0 font-medium">Theme</p>
                  <p className="m-0 mt-1 text-sm text-muted-foreground">
                    Scan images stay dark in either theme.
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  {(
                    [
                      { value: "light", label: "Light", preview: lightPreview },
                      { value: "dark", label: "Dark", preview: darkPreview },
                    ] as const
                  ).map(({ value, label, preview }) => (
                    <label
                      key={value}
                      className={save.isPending ? "cursor-wait" : "cursor-pointer"}
                    >
                      <input
                        type="radio"
                        name="theme"
                        value={value}
                        checked={settings.data.theme === value}
                        onChange={() => {
                          if (!save.isPending) save.mutate({ theme: value });
                        }}
                        className="peer sr-only"
                      />
                      <span className="block w-40 rounded-md border border-border bg-card p-1.5 hover:border-line-strong peer-checked:border-select peer-checked:bg-select-tint peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
                        <img
                          src={preview}
                          alt=""
                          width={560}
                          height={350}
                          className="block w-full rounded-sm border border-border"
                        />
                        <span className="mt-2 flex items-center justify-between">
                          {label}
                          {settings.data.theme === value && (
                            <Check aria-hidden="true" className="size-3.5 text-select-text" />
                          )}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </fieldset>
            <p role="status" className="m-0 min-h-5 text-sm text-muted-foreground">
              {save.isPending ? "Saving…" : save.isSuccess ? "Saved" : ""}
            </p>
          </>
        )}
        {save.isError && (
          <ErrorState className="mt-3" title="Couldn't save your theme">
            Your previous theme is unchanged. Choose a theme to try again.
          </ErrorState>
        )}
      </section>
    </div>
  );
}
