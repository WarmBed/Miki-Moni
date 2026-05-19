import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same __APP_VERSION__ injection as vite.config.ts. The phone build also
// loads web/app.tsx (via dynamic import in main-tunnel.tsx), and that file
// references __APP_VERSION__ in the settings popover — without this define
// the phone bundle ships an unbound identifier and the popover throws
// ReferenceError on open.
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  root: path.join(__dirname, "web-phone"),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: path.join(__dirname, "dist", "web-phone"),
    emptyOutDir: true,
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
      "@shared": path.join(__dirname, "shared"),
    },
  },
  server: { fs: { allow: [__dirname] } },
});
