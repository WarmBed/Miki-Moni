import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(__dirname, "web-phone"),
  build: {
    outDir: path.join(__dirname, "dist", "web-phone"),
    emptyOutDir: true,
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  resolve: {
    alias: { react: "preact/compat", "react-dom": "preact/compat" },
  },
});
