/* eslint-env node */
module.exports = {
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  overrides: [
    {
      files: ["**/*.ts"],
      extends: [
        "eslint:recommended",
        "plugin:@typescript-eslint/strict-type-checked",
        "plugin:@typescript-eslint/stylistic-type-checked",
        "plugin:@typescript-eslint/recommended",
        "prettier",
      ],
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: __dirname,
      },
    },
    {
      files: ["**/*.mjs", "**/*.cjs"],
      env: {
        es2021: true,
        node: true,
      },
      extends: ["eslint:recommended", "prettier"],
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
  ],
  root: true,
};
