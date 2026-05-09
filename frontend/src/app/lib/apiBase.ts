/**
 * Single source of truth for the backend API base URL.
 *
 * Refuses to fall back to a hardcoded http://localhost:3001 the way every
 * call site used to — that fallback hid misconfiguration in production
 * and would let the browser ship JWTs / documents / API keys over
 * plaintext. NEXT_PUBLIC_API_BASE_URL must be set explicitly in every
 * environment, and must be https:// when NODE_ENV is "production".
 *
 * In production: throws at module load if missing or not https://.
 * In dev: still requires the var, but allows http:// for localhost so
 * developers can run the backend on http://localhost:3001 without a
 * cert.
 *
 * Use the exported `apiBase()` helper at every call site instead of
 * reading process.env directly — that keeps the validation in one place
 * and lets the ESLint `no-restricted-syntax` guard catch regressions.
 */

const RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;

const IS_PROD = process.env.NODE_ENV === "production";

function validate(value: string | undefined): string {
    if (!value || value.trim().length === 0) {
        throw new Error(
            "NEXT_PUBLIC_API_BASE_URL must be set. The previous fallback to http://localhost:3001 was a foot-gun and has been removed.",
        );
    }
    const trimmed = value.replace(/\/+$/g, "");
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error(
            `NEXT_PUBLIC_API_BASE_URL is not a valid URL: ${trimmed}`,
        );
    }
    if (IS_PROD && parsed.protocol !== "https:") {
        throw new Error(
            `NEXT_PUBLIC_API_BASE_URL must be https:// in production (got ${parsed.protocol}//). Plaintext HTTP would expose every JWT, document, and API key transmitted by the app.`,
        );
    }
    return trimmed;
}

const VALIDATED = validate(RAW_API_BASE);

export function apiBase(): string {
    return VALIDATED;
}
