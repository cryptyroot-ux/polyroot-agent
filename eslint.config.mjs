import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

/** ESLint 9 flat config — no type-aware rules until Sprint 2. */
export default [
  {
    ignores: ["node_modules/", "**/dist/", "coverage/", ".turbo/", "**/*.d.ts"],
  },
  {
    files: ["**/*.ts", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2024, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      // Base `eslint:recommended` equivalent for TS is intentionally
      // minimal here; type-aware rules arrive with Sprint 2 repositories.
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },
  {
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
  },
];
