/**
 * Joins class names, skipping falsy parts. Later classes win over earlier ones for the same CSS
 * property (tailwind-merge), so a caller's `className` overrides a part's default: plain
 * joining would leave the winner to Tailwind's stylesheet order.
 */
import { extendTailwindMerge } from "tailwind-merge";

// The theme's own names tailwind-merge can't know: without them `text-meta` reads as a colour
// and `shadow-pop` as a shadow colour, and either would drop a real one.
const merge = extendTailwindMerge({
  extend: { theme: { text: ["meta", "ui"], shadow: ["pop"] } },
});

export function cx(...parts: Array<string | false | null | undefined>): string {
  return merge(parts.filter(Boolean).join(" "));
}
