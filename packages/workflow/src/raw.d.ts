// Vite's `?raw` imports (a file's text), for `output-catalogs.ts`; the web app gets the same type from `vite/client`.
declare module "*?raw" {
  const text: string;
  export default text;
}
