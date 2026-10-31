// Token swatches for the Foundations pages: each colour role in the theme it is shown in.
const roles: [string, string][] = [
  ["background", "The chassis: the seams between panels"],
  ["card", "Every panel"],
  ["muted", "Sunken wells: readouts, list heads"],
  ["accent", "Hover fill"],
  ["secondary", "Raised fills: secondary button, selected row"],
  ["border", "Lines between rows and panels"],
  ["foreground", "Text"],
  ["muted-foreground", "Secondary text"],
  ["fg-subtle", "Quiet text, at least 4.5:1"],
  ["primary", "The one main action on a view"],
  ["select", "Selection, focus, crosshairs. Never a status"],
  ["check-solid", "To check"],
  ["info-solid", "Running, corrected"],
  ["done-solid", "Done"],
  ["destructive-solid", "Stopped, failed"],
  ["idle", "Waiting, paused"],
  ["mark-mine", "Your marks on the scan"],
  ["mark-mine-text", "Your mark tags in text"],
  ["mark-ai", "The AI's marks on the scan"],
];

export function Swatches() {
  return (
    <div className="grid grid-cols-2 gap-px bg-border">
      {(["light", "dark"] as const).map((t) => (
        <div key={t} data-theme={t} className="bg-card p-4">
          <div className="mb-3 font-medium">
            {t === "light" ? "Light: home and study pages" : "Dark: the 3D review"}
          </div>
          {roles.map(([name, use]) => (
            <div key={name} className="flex items-center gap-3 py-1">
              <span
                className="size-6 shrink-0 rounded-sm border border-border"
                style={{ background: `var(--${name})` }}
              />
              <span className="w-40 font-mono text-xs">{name}</span>
              <span className="text-sm text-muted-foreground">{use}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
