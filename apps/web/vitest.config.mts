import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": `${process.cwd()}/src` } },
  test: { environment: "node" }
});
