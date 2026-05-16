import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    alias: {
      vscode: path.resolve(__dirname, "./tests/vscode-mock.ts"),
    },
  },
});
