import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "*.config.*"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Pragmatic baseline for an SDK: surface real problems, don't fight style.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
