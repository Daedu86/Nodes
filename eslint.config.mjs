import { defineConfig } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      // Next 16 enables React Compiler advisory rules that were not part of the
      // repository's previous lint contract. Keep established hooks correctness
      // rules such as exhaustive-deps, while deferring compiler-specific refactors
      // to a dedicated change with focused behavioral testing.
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["services/codex-runner/evolution-orchestrator.mjs"],
    rules: {
      // Generation evidence deliberately strips the winning spec with object-rest
      // before persisting attempt snapshots. Treat that sibling omission as use.
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["tests/e2e/smoke.spec.ts"],
    rules: {
      // The smoke suite intentionally retains intermediate snapshots for
      // failure diagnosis while scenarios evolve. Production code remains strict.
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",
    },
  },
]);