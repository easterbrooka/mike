import crypto from "crypto";

/**
 * HMAC-signed, non-expiring download tokens.
 *
 * The token encodes the storage path + filename + issued-at timestamp; the
 * backend route `/download/:token` validates the signature and streams the
 * file. This gives persistent links safe to store in chat history without
 * signed-URL expiry headaches. Authorisation is enforced separately by
 * `requireAuth + ensureDocAccess` on the download route — the token is
 * just a tamper-resistant reference to the (path, filename) pair.
 *
 * Future hardening (deferred to a follow-up): bind tokens to a userId and
 * add a TTL. That requires migrating chat-rendered link generation
 * (chatTools.ts) to a fetch-on-demand model so historical chat links
 * keep working.
 */

function getSecret(): string {
    const secret =
        process.env.DOWNLOAD_SIGNING_SECRET ??
        process.env.SUPABASE_SECRET_KEY ??
        null;
    if (!secret) {
        throw new Error(
            "DOWNLOAD_SIGNING_SECRET (or SUPABASE_SECRET_KEY) must be set; the previous 'dev-secret' fallback was a foot-gun and has been removed.",
        );
    }
    return secret;
}

function b64urlEncode(buf: Buffer): string {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return Buffer.from(t, "base64");
}

function timingSafeEqStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface VerifiedDownload {
    path: string;
    filename: string;
    /** Unix seconds; populated for tokens minted after the iat-payload upgrade. */
    iat?: number;
}

export function signDownload(path: string, filename: string): string {
    const payload = JSON.stringify({
        p: path,
        f: filename,
        iat: Math.floor(Date.now() / 1000),
    });
    const enc = b64urlEncode(Buffer.from(payload, "utf8"));
    const sig = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyDownload(token: string): VerifiedDownload | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    if (!enc || !sigEnc) return null;
    const expected = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    if (!timingSafeEqStr(sigEnc, b64urlEncode(expected))) return null;
    try {
        const parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as {
            p?: string;
            f?: string;
            iat?: number;
        };
        if (!parsed?.p || !parsed?.f) return null;
        return {
            path: parsed.p,
            filename: parsed.f,
            iat: typeof parsed.iat === "number" ? parsed.iat : undefined,
        };
    } catch {
        return null;
    }
}

/**
 * Returns a relative download URL (e.g. "/download/abc.def"). The frontend
 * prefixes it with NEXT_PUBLIC_API_BASE_URL when rendering `<a href=…>`.
 */
export function buildDownloadUrl(path: string, filename: string): string {
    return `/download/${signDownload(path, filename)}`;
}
