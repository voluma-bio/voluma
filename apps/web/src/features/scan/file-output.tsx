/**
 * A file output in the panes' place: its own file as it reads (JSON laid out, Markdown rendered,
 * an image shown, other text as is), beside the evidence it was checked on. The file comes from
 * the run's outputs (`outputFileUrl`); a large one shows its start.
 */
import { useQuery } from "@tanstack/react-query";
import { outputFileUrl } from "@voluma/api-client";
import type { OutputVersion } from "@voluma/contracts/output-fold";
import { Markdown } from "@voluma/run-view";
import { ErrorState, LoadingState } from "@voluma/ui";

/** The most of a file's text shown, in characters. */
const MAX_TEXT = 200_000;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

export function FileOutput({ runId, version }: { runId: string; version: OutputVersion }) {
  const file = version.files[0];
  const images = version.evidence.filter((e) => IMAGE.test(e.name));
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] bg-background">
      <div className="min-h-0 overflow-auto p-4">
        {file ? (
          <FileText runId={runId} path={`${version.path}/${file.name}`} name={file.name} />
        ) : (
          <p className="text-sm text-muted-foreground">This version has no file.</p>
        )}
      </div>
      <div className="min-h-0 overflow-auto bg-viewer-well p-3">
        {images.length === 0 ? (
          <p className="p-3 text-sm text-viewer-chip-fg">No images came with this version.</p>
        ) : (
          <div className="grid gap-3">
            {images.map((e) => (
              <figure key={e.name} className="grid gap-1">
                <img
                  src={outputFileUrl(runId, `${version.path}/${e.name}`)}
                  alt={e.name}
                  loading="lazy"
                  className="w-full object-contain"
                />
                <figcaption className="font-mono text-xs text-viewer-chip-fg">
                  {e.name.replace(/^evidence\//, "")}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FileText({ runId, path, name }: { runId: string; path: string; name: string }) {
  const url = outputFileUrl(runId, path);
  const text = useQuery({
    queryKey: ["output-file", runId, path],
    enabled: !IMAGE.test(name),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }) => {
      const res = await fetch(url, { signal });
      if (!res.ok)
        throw new Error(res.status === 404 ? "The file isn't there." : `HTTP ${res.status}`);
      return res.text();
    },
  });
  if (IMAGE.test(name)) return <img src={url} alt={name} className="max-w-full" />;
  if (text.isPending) return <LoadingState label={`Loading ${name}`} rows={6} />;
  if (text.isError)
    return <ErrorState title={`Couldn't load ${name}`}>{text.error.message}</ErrorState>;
  const cut = text.data.length > MAX_TEXT;
  const shown = cut ? text.data.slice(0, MAX_TEXT) : text.data;
  let body = <pre className="font-mono text-xs whitespace-pre-wrap">{shown}</pre>;
  if (/\.json$/i.test(name) && !cut)
    try {
      body = (
        <pre className="font-mono text-xs whitespace-pre-wrap">
          {JSON.stringify(JSON.parse(shown), null, 2)}
        </pre>
      );
    } catch {
      // Not valid JSON: shown as written.
    }
  if (/\.md$/i.test(name)) body = <Markdown text={shown} className="text-sm" />;
  return (
    <div className="grid gap-2">
      <h3 className="font-mono text-sm">{name}</h3>
      {body}
      {cut && (
        <p className="text-xs text-muted-foreground">
          The first {MAX_TEXT.toLocaleString()} characters.{" "}
          <a href={url} download className="underline">
            Download the whole file
          </a>
        </p>
      )}
    </div>
  );
}
