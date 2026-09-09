/** ESLint 8 (eslintrc) baseline — no type-aware rules until Sprint 2. */
module.exports = {
  root: true,
  env: { node: true, es2024: true },
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2024, sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: [
    "node_modules/",
    "dist/",
    "coverage/",
    ".turbo/",
    "**/*.d.ts",
  ],
  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "no-console": "off",
  },
};
