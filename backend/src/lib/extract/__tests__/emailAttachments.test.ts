import { describe, expect, it } from "vitest";
import {
    MAX_PER_ATTACHMENT_CHARS,
    MAX_TOTAL_ATTACHMENT_CHARS,
    expandAttachmentText,
    renderAttachments,
} from "../emailAttachments";

function txtBuf(s: string): Buffer {
    return Buffer.from(s, "utf8");
}

describe("expandAttachmentText", () => {
    it("renders a .txt attachment with a header", async () => {
        const out = await expandAttachmentText(
            { filename: "notes.txt", bytes: txtBuf("hello world") },
            0,
        );
        expect(out).toContain("--- Attachment: notes.txt ---");
        expect(out).toContain("hello world");
    });

    it("returns null for image suffixes (inline signature noise)", async () => {
        for (const ext of ["png", "jpg", "jpeg", "gif", "svg", "webp"]) {
            const out = await expandAttachmentText(
                { filename: `signature.${ext}`, bytes: Buffer.alloc(10) },
                0,
            );
            expect(out).toBeNull();
        }
    });

    it("returns null for unknown suffixes (zip, exe, csv)", async () => {
        for (const ext of ["zip", "exe", "csv", "rtf", "bin"]) {
            const out = await expandAttachmentText(
                { filename: `payload.${ext}`, bytes: Buffer.alloc(10) },
                0,
            );
            expect(out).toBeNull();
        }
    });

    it("returns null for filenames without an extension", async () => {
        const out = await expandAttachmentText(
            { filename: "no_extension", bytes: txtBuf("x") },
            0,
        );
        expect(out).toBeNull();
    });

    it("truncates a .txt attachment that exceeds the per-attachment cap", async () => {
        const big = "x".repeat(MAX_PER_ATTACHMENT_CHARS + 5_000);
        const out = await expandAttachmentText(
            { filename: "huge.txt", bytes: txtBuf(big) },
            0,
        );
        expect(out).not.toBeNull();
        expect(out!.length).toBeLessThan(big.length + 200);
        expect(out).toMatch(/attachment truncated at .* chars/);
    });
});

describe("renderAttachments", () => {
    it("returns an empty string when given no attachments", async () => {
        expect(await renderAttachments([], 0)).toBe("");
    });

    it("concatenates multiple .txt attachments with header sections", async () => {
        const out = await renderAttachments(
            [
                { filename: "a.txt", bytes: txtBuf("alpha-content") },
                { filename: "b.txt", bytes: txtBuf("beta-content") },
            ],
            0,
        );
        expect(out).toContain("--- Attachment: a.txt ---");
        expect(out).toContain("alpha-content");
        expect(out).toContain("--- Attachment: b.txt ---");
        expect(out).toContain("beta-content");
    });

    it("silently drops skipped types from the rendered output", async () => {
        const out = await renderAttachments(
            [
                { filename: "ok.txt", bytes: txtBuf("inside") },
                { filename: "noise.png", bytes: Buffer.alloc(10) },
                { filename: "archive.zip", bytes: Buffer.alloc(10) },
            ],
            0,
        );
        expect(out).toContain("ok.txt");
        expect(out).not.toContain("noise.png");
        expect(out).not.toContain("archive.zip");
    });

    it("hits the total cap when many large attachments would overflow", async () => {
        const oneAttachment = "y".repeat(MAX_PER_ATTACHMENT_CHARS);
        const tenLargeAttachments = Array.from({ length: 10 }, (_, i) => ({
            filename: `large-${i}.txt`,
            bytes: txtBuf(oneAttachment),
        }));
        const out = await renderAttachments(tenLargeAttachments, 0);
        // 10 × 50k = 500k uncapped; should be ≤ 400k + a small fudge for
        // overhead lines.
        expect(out.length).toBeLessThan(MAX_TOTAL_ATTACHMENT_CHARS + 1000);
        // The cap signpost should be present somewhere.
        expect(out).toMatch(
            /(attachment block truncated|further attachment\(s\) omitted)/,
        );
    });
});
