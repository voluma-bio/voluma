// Storybook for the component library: every shared component in both themes, with a docs page
// saying what it is for and where it is used. Stories live next to their components.

import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";
import remarkGfm from "remark-gfm";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: [
    "../src/**/*.mdx",
    "../../../packages/ui/src/**/*.stories.tsx",
    "../../../packages/run-view/src/**/*.stories.tsx",
  ],
  // remark-gfm: the docs pages use Markdown tables.
  addons: [
    {
      name: "@storybook/addon-docs",
      options: { mdxPluginOptions: { mdxCompileOptions: { remarkPlugins: [remarkGfm] } } },
    },
  ],
  core: { disableTelemetry: true },
  viteFinal: (vite) => ({ ...vite, plugins: [...(vite.plugins ?? []), tailwindcss()] }),
};
export default config;
