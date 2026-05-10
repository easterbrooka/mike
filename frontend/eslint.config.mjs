import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Block insecure-fallback API base URLs. NEXT_PUBLIC_API_BASE_URL must be
// set explicitly (and to https://) in every environment — falling back to
// http://localhost:3001 hides misconfiguration in production and would let
// the browser send JWTs / documents over plaintext.
const HTTP_LOCALHOST_PATTERN = "/^http:\\/\\/localhost/";
const httpLocalhostMessage =
  "Hardcoded http://localhost URLs are forbidden. Read NEXT_PUBLIC_API_BASE_URL with no fallback (or use a helper that throws if it isn't an https URL).";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx,js,jsx,mjs}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=${HTTP_LOCALHOST_PATTERN}]`,
          message: httpLocalhostMessage,
        },
        {
          selector: `TemplateElement[value.raw=${HTTP_LOCALHOST_PATTERN}]`,
          message: httpLocalhostMessage,
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
