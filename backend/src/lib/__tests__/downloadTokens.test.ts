import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    buildDownloadUrl,
    signDownload,
    verifyDownload,
} from "../downloadTokens";

const ENV_SNAPSHOT = {
    DOWNLOAD_SIGNING_SECRET: process.env.DOWNLOAD_SIGNING_SECRET,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
};

describe("downloadTokens", () => {
    beforeEach(() => {
        process.env.DOWNLOAD_SIGNING_SECRET = "unit-test-secret-A";
        delete process.env.SUPABASE_SECRET_KEY;
    });

    afterEach(() => {
        process.env.DOWNLOAD_SIGNING_SECRET = ENV_SNAPSHOT.DOWNLOAD_SIGNING_SECRET;
        process.env.SUPABASE_SECRET_KEY = ENV_SNAPSHOT.SUPABASE_SECRET_KEY;
    });

    it("round-trips a path/filename through sign + verify", () => {
        const token = signDownload(
            "documents/u123/d456/source.pdf",
            "Client Brief.pdf",
        );
        const verified = verifyDownload(token);
        expect(verified).toEqual({
            path: "documents/u123/d456/source.pdf",
            filename: "Client Brief.pdf",
        });
    });

    it("preserves unicode filenames", () => {
        const token = signDownload(
            "documents/u/d/source.docx",
            "Mémoire — résumé 中文.docx",
        );
        expect(verifyDownload(token)?.filename).toBe(
            "Mémoire — résumé 中文.docx",
        );
    });

    it("rejects a tampered payload section", () => {
        const token = signDownload("documents/a/b/source.pdf", "x.pdf");
        const [, sig] = token.split(".");
        const forged = `${Buffer.from(
            JSON.stringify({ p: "documents/EVIL/source.pdf", f: "x.pdf" }),
            "utf8",
        )
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "")}.${sig}`;
        expect(verifyDownload(forged)).toBeNull();
    });

    it("rejects a tampered signature section", () => {
        const token = signDownload("documents/a/b/source.pdf", "x.pdf");
        const [enc] = token.split(".");
        expect(verifyDownload(`${enc}.AAAAAAAA`)).toBeNull();
    });

    it("rejects a token signed with a different secret", () => {
        const token = signDownload("documents/a/b/source.pdf", "x.pdf");
        process.env.DOWNLOAD_SIGNING_SECRET = "unit-test-secret-B";
        expect(verifyDownload(token)).toBeNull();
    });

    it("rejects malformed tokens", () => {
        expect(verifyDownload("")).toBeNull();
        expect(verifyDownload("nodot")).toBeNull();
        expect(verifyDownload("a.b.c")).toBeNull();
        expect(verifyDownload(".sig")).toBeNull();
        expect(verifyDownload("payload.")).toBeNull();
    });

    it("rejects payloads missing required fields", () => {
        const enc = Buffer.from(JSON.stringify({ p: "x" }), "utf8")
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
        const crypto = require("node:crypto");
        const sig = crypto
            .createHmac("sha256", "unit-test-secret-A")
            .update(enc)
            .digest()
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
        expect(verifyDownload(`${enc}.${sig}`)).toBeNull();
    });

    it("buildDownloadUrl returns a /download/<token> path", () => {
        const url = buildDownloadUrl("documents/a/b/source.pdf", "x.pdf");
        expect(url.startsWith("/download/")).toBe(true);
        const token = url.slice("/download/".length);
        expect(verifyDownload(token)).toEqual({
            path: "documents/a/b/source.pdf",
            filename: "x.pdf",
        });
    });

    it("falls back to SUPABASE_SECRET_KEY when DOWNLOAD_SIGNING_SECRET is unset", () => {
        // Documents the current fallback chain. Phase 1 of the encryption
        // remediation removes the "dev-secret" final fallback and makes
        // DOWNLOAD_SIGNING_SECRET mandatory; this test will then split into
        // "uses SUPABASE_SECRET_KEY" + "throws when neither is set".
        delete process.env.DOWNLOAD_SIGNING_SECRET;
        process.env.SUPABASE_SECRET_KEY = "supabase-fallback";
        const token = signDownload("documents/a/b/source.pdf", "x.pdf");
        expect(verifyDownload(token)).toEqual({
            path: "documents/a/b/source.pdf",
            filename: "x.pdf",
        });
    });
});
