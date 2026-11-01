// Flat config (ESLint 9+). A straight port of the former .eslintrc.json:
// same rules, same file scopes, same ignores.
import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

const noConsole = { "no-console": "off" };

export default [
  {
    ignores: [
      "**/dist/**",
      "**/dist-test/**",
      "**/node_modules/**",
      ".vscode/**",
      "coverage/**",
      "opencode-orchestration/mcp-server/**",
      "opencode-orchestration/scripts/**",
      "opencode-orchestration/packs/**",
      "xx-stack/packs/**",
    ],
  },

  // TypeScript sources: eslint:recommended first, typescript-eslint on top
  // (it switches off core rules that misfire on TS, e.g. no-unused-vars).
  { files: ["**/*.ts"], rules: js.configs.recommended.rules },
  ...tsPlugin.configs["flat/recommended"].map((config) => ({ ...config, files: ["**/*.ts"] })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-namespace": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  {
    files: [
      "packages/plugin/src/cli.ts",
      "packages/plugin/src/proxy/admin.ts",
      "xx-stack/mcp-server/src/monitor-memory.ts",
      "xx-stack/mcp-server/src/parallel-preflight.ts",
      "xx-stack/mcp-server/src/parallel-smoke.ts",
      "xx-stack/mcp-server/src/trace-provider-proxy.ts",
    ],
    rules: noConsole,
  },

  // Plain JavaScript tooling (repo scripts, MCP build helpers).
  {
    files: [
      "xx-stack/scripts/**/*.mjs",
      "xx-stack/scripts/**/*.js",
      "xx-stack/mcp-server/**/*.mjs",
      "scripts/**/*.mjs",
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2021 },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...noConsole,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-shadow": "error",
      "no-undef": "error",
    },
  },
  {
    // CommonJS helpers: see the `//type` note in the root package.json.
    files: ["xx-stack/scripts/**/*.js"],
    languageOptions: { sourceType: "script" },
  },
];
