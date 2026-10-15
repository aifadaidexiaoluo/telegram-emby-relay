//  @ts-check

import { tanstackConfig } from "@tanstack/eslint-config"

export default [
  ...tanstackConfig,
  {
    rules: {
      "import/no-cycle": "off",
      "import/order": "off",
      "import/consistent-type-specifier-style": "off",
      "sort-imports": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/require-await": "off",
      "pnpm/json-enforce-catalog": "off",
    },
  },
  {
    files: ["src/server/**/*.ts"],
    rules: {
      // Shared runtime flags change across awaits, beyond TypeScript's flow narrowing.
      "@typescript-eslint/no-unnecessary-condition": "off",
      "no-control-regex": "off",
    },
  },
  {
    files: ["src/lib/validation.ts"],
    rules: { "no-control-regex": "off" },
  },
  {
    ignores: [
      "eslint.config.js",
      ".prettierrc",
      ".output/**",
      ".nitro/**",
      ".tanstack/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
]
