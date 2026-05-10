import { describe, expect, it } from "vitest";
import {
    buildContentDisposition,
    encodeRFC5987,
    generatedDocKey,
    normalizeDownloadFilename,
    pdfStorageKey,
    sanitizeDispositionFilename,
    storageKey,
    versionStorageKey,
} from "../storage";

describe("storage key helpers", () => {
    describe("storageKey", () => {
        it("uses the file extension when one is present", () => {
            expect(storageKey("u1", "d1", "Brief.pdf")).toBe(
                "documents/u1/d1/source.pdf",
            );
            expect(storageKey("u1", "d1", "Brief.DOCX")).toBe(
                "documents/u1/d1/source.docx",
            );
        });

        it("falls back to .bin when extension is missing or weird", () => {
            expect(storageKey("u1", "d1", "no-extension")).toBe(
                "documents/u1/d1/source.bin",
            );
            expect(storageKey("u1", "d1", "weird.<<>>")).toBe(
                "documents/u1/d1/source.bin",
            );
            expect(
                storageKey("u1", "d1", `way.${"x".repeat(20)}`),
            ).toBe("documents/u1/d1/source.bin");
        });
    });

    describe("pdfStorageKey", () => {
        it("places the stem in the per-doc folder with .pdf", () => {
            expect(pdfStorageKey("u1", "d1", "Brief")).toBe(
                "documents/u1/d1/Brief.pdf",
            );
        });
    });

    describe("generatedDocKey", () => {
        it("preserves docx extension", () => {
            expect(generatedDocKey("u1", "d1", "Output.docx")).toBe(
                "generated/u1/d1/generated.docx",
            );
        });

        it("falls back to .docx when missing extension", () => {
            expect(generatedDocKey("u1", "d1", "noext")).toBe(
                "generated/u1/d1/generated.docx",
            );
        });
    });

    describe("versionStorageKey", () => {
        it("nests under versions/<slug>", () => {
            expect(
                versionStorageKey("u1", "d1", "v3-abc", "Snap.pdf"),
            ).toBe("documents/u1/d1/versions/v3-abc.pdf");
        });
    });
});

describe("download filename hardening", () => {
    it("normalizeDownloadFilename strips control characters", () => {
        expect(normalizeDownloadFilename("evil\x00.pdf")).toBe("evil_.pdf");
        expect(normalizeDownloadFilename("crlf\r\n.pdf")).toBe("crlf__.pdf");
        expect(normalizeDownloadFilename("tab\t.pdf")).toBe("tab_.pdf");
    });

    it("normalizeDownloadFilename strips path separators", () => {
        expect(normalizeDownloadFilename("a/b\\c.pdf")).toBe("a_b_c.pdf");
    });

    it("normalizeDownloadFilename falls back to 'download' when empty", () => {
        expect(normalizeDownloadFilename("")).toBe("download");
        expect(normalizeDownloadFilename("   ")).toBe("download");
    });

    it("sanitizeDispositionFilename additionally strips quotes and backslashes", () => {
        expect(sanitizeDispositionFilename('a"b.pdf')).toBe("a_b.pdf");
        expect(sanitizeDispositionFilename("a\\b.pdf")).toBe("a_b.pdf");
    });

    it("encodeRFC5987 escapes the special set RFC 5987 reserves", () => {
        expect(encodeRFC5987("a b")).toBe("a%20b");
        expect(encodeRFC5987("a'b")).toBe("a%27b");
        expect(encodeRFC5987("(a)")).toBe("%28a%29");
        expect(encodeRFC5987("*")).toBe("%2A");
    });

    it("encodeRFC5987 round-trips unicode through percent encoding", () => {
        expect(decodeURIComponent(encodeRFC5987("résumé"))).toBe("résumé");
    });

    it("buildContentDisposition emits both filename and filename* parameters", () => {
        const header = buildContentDisposition("attachment", "résumé.pdf");
        expect(header).toContain("attachment;");
        // Plain filename retains UTF-8 bytes (legacy browsers); the
        // filename* parameter carries the canonical UTF-8 percent-encoded
        // form per RFC 6266.
        expect(header).toContain('filename="résumé.pdf"');
        expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    });

    it("buildContentDisposition strips quotes from the plain filename", () => {
        const header = buildContentDisposition("attachment", 'evil".pdf');
        expect(header).toContain('filename="evil_.pdf"');
    });

    it("buildContentDisposition supports inline disposition", () => {
        expect(
            buildContentDisposition("inline", "x.pdf").startsWith("inline;"),
        ).toBe(true);
    });
});
