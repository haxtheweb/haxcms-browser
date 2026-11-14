import js from "@eslint/js";
import nodePlugin from "eslint-plugin-n";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

// Team convention: no `?.` optional chaining. The project's Babel/parser
// toolchain has had issues with this syntax; see AGENTS.md / hax audit.
export const noOptionalChaining = {
  selector: "ChainExpression",
  message:
    "Optional chaining (`?.`) is banned in this codebase; use an explicit guard (e.g. `a && a.b`) instead.",
};

// Team convention: prefer `globalThis` over bare `window`. The runtime runs in
// a Worker, where there is no window at all.
export const noWindowGlobal = {
  selector: "Identifier[name='window']",
  message: "Use `globalThis` instead of `window` for global-scope references.",
};

// Security: shell-string exec() with interpolated values is a command
// injection risk. Pass arguments as an array (spawnSync(cmd, [args])).
export const noInterpolatedExec = {
  selector:
    "CallExpression[callee.name='exec'] > TemplateLiteral[expressions.length>0]",
  message:
    "Do not interpolate values into exec() shell strings; pass arguments as an array.",
};

const restricted = [
  "error",
  noOptionalChaining,
  noWindowGlobal,
  noInterpolatedExec,
];

export default [
  {
    // build output, the haxcms-nodejs checkout CI builds against, and tests
    // (exercised by `npm test`) are not linted.
    ignores: [
      "dist/**",
      "site/**",
      "node_modules/**",
      "coverage/**",
      ".haxcms-nodejs/**",
      "test/**",
    ],
  },
  js.configs.recommended,
  {
    // build and repo tooling: ESM on Node
    files: ["scripts/**/*.mjs", "*.mjs"],
    ...nodePlugin.configs["flat/recommended-module"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...nodePlugin.configs["flat/recommended-module"].rules,
      "no-restricted-syntax": restricted,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      eqeqeq: "error",
      "no-var": "error",
      // build tooling is installed as devDependencies on purpose
      "n/no-unpublished-import": "off",
    },
  },
  {
    // the runtime: CommonJS bundled into a Worker. process and Buffer are
    // provided by the bundle (src/runtime/shims/globals.mjs).
    files: ["src/runtime/**/*.cjs", "src/runtime/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.worker,
        ...globals.commonjs,
        process: "readonly",
        Buffer: "readonly",
      },
    },
    rules: {
      "no-restricted-syntax": restricted,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      eqeqeq: "error",
      "no-var": "error",
    },
  },
  {
    files: ["src/runtime/**/*.mjs"],
    languageOptions: { sourceType: "module" },
  },
  {
    // the publish broker: CommonJS Vercel functions on Node (api/_lib/broker.js)
    files: ["api/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "no-restricted-syntax": restricted,
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      eqeqeq: "error",
      "no-var": "error",
    },
  },
  {
    // the host page and its service worker: plain scripts, served as they are
    files: ["src/site/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    rules: {
      "no-restricted-syntax": restricted,
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      eqeqeq: "error",
      "no-var": "error",
    },
  },
  eslintConfigPrettier,
];
