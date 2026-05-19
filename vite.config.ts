import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read version from package.json at build time. Injected as the global
// constant `__APP_VERSION__` (see web/app.tsx). Surfaces in the settings
// popover footer so users can verify which build they're running.
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  root: "web",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "../dist/web",
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
      // Shared i18n module — used by both web/ and web-phone/.
      "@shared": path.join(__dirname, "shared"),
    },
  },
  server: { fs: { allow: [__dirname] } },
});
