// Every story renders in both themes side by side, since the user picks Light or Dark in
// settings. The toolbar can narrow it to one.
import "../src/styles.css";
import type { Decorator, Preview } from "@storybook/react-vite";

const themes = ["light", "dark"] as const;

const withThemes: Decorator = (Story, context) => {
  const shown = context.globals.theme === "both" ? themes : [context.globals.theme];
  return (
    <div
      className="grid min-h-screen"
      style={{ gridTemplateColumns: `repeat(${shown.length}, 1fr)` }}
    >
      {shown.map((t) => (
        <div key={t} data-theme={t} className="bg-card p-6 text-foreground">
          <Story />
        </div>
      ))}
    </div>
  );
};

const preview: Preview = {
  decorators: [withThemes],
  parameters: { layout: "fullscreen", controls: { expanded: true } },
  globalTypes: {
    theme: {
      description: "Theme",
      toolbar: { icon: "contrast", items: ["both", "light", "dark"], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: "both" },
  tags: ["autodocs"],
};
export default preview;
