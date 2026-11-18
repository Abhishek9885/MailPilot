import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";
import globals from "globals";
import path from "node:path";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "apps/web");
const nextRules = [...nextVitals, ...nextTypeScript]
  .filter((configuration) => !configuration.ignores)
  .map((configuration) => ({
    ...configuration,
    files: ["apps/web/**/*"],
    settings: {
      ...configuration.settings,
      next: { ...configuration.settings?.next, rootDir: webRoot }
    },
    rules: { ...configuration.rules, "@next/next/no-html-link-for-pages": "off" }
  }));

export default defineConfig([
  ...nextRules,
  ...tseslint.configs.recommended,
  {
    files: ["apps/api/**/*.{js,ts}", "packages/shared/**/*.{js,ts}"],
    languageOptions: { globals: globals.node }
  },
  globalIgnores([
    "**/node_modules/**",
    "**/.next/**",
    "**/dist/**",
    "apps/api/src/generated/**",
    "coverage/**",
    "apps/web/next-env.d.ts"
  ])
]);
