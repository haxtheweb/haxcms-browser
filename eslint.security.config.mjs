// Security-only ESLint gate: the selectors from eslint.config.mjs that CI must
// never let through (shell-string exec() interpolation, and optional chaining),
// run as a blocking step (`npm run lint:security`). The selectors are imported
// from the base config so the two can't drift.
import globals from "globals";
import baseConfig, {
  noInterpolatedExec,
  noOptionalChaining,
} from "./eslint.config.mjs";

// reuse the base ignore list so build output and tests are skipped
const ignores = baseConfig.find((c) => c.ignores && !c.files).ignores;

export default [
  { ignores },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-restricted-syntax": ["error", noInterpolatedExec, noOptionalChaining],
    },
  },
  {
    files: ["src/runtime/**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.worker, ...globals.commonjs },
    },
    rules: {
      "no-restricted-syntax": ["error", noInterpolatedExec, noOptionalChaining],
    },
  },
];
