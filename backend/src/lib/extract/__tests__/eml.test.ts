import { describe, expect, it } from "vitest";
import { extractEml, emlToLLMText } from "../eml";

function emlBuf(raw: string): ArrayBuffer {
    const b = Buffer.from(raw, "utf8");
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const SAMPLE_PLAIN = [
    "From: Alice <alice@example.com>",
    "To: Bob <bob@example.com>",
    "Cc: carol@example.com",
    "Subject: Lunch?",
    "Date: Mon, 11 May 2026 12:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hey Bob,",
    "",
    "Want to grab lunch on Friday?",
    "",
    "— Alice",
    "",
].join("\r\n");

describe("extractEml", () => {
    it("parses headers and plain-text body", async () => {
        const eml = await extractEml(emlBuf(SAMPLE_PLAIN));
        expect(eml.subject).toBe("Lunch?");
        expect(eml.from).toMatch(/alice@example\.com/);
        expect(eml.to).toMatch(/bob@example\.com/);
        expect(eml.cc).toMatch(/carol@example\.com/);
        expect(eml.date).toMatch(/^2026-05-11T/);
        expect(eml.text).toContain("Want to grab lunch on Friday");
        expect(eml.attachments).toEqual([]);
    });

    it("falls back to stripped HTML when no plain-text part", async () => {
        const html = [
            "From: a@x.com",
            "To: b@x.com",
            "Subject: HTML-only",
            "Date: Mon, 11 May 2026 12:00:00 +0000",
            "Content-Type: text/html; charset=utf-8",
            "",
            "<p>Hello <strong>world</strong></p><p>Second paragraph</p>",
            "",
        ].join("\r\n");
        const eml = await extractEml(emlBuf(html));
        expect(eml.text).toContain("Hello world");
        expect(eml.text).toContain("Second paragraph");
        expect(eml.text).not.toContain("<p>");
        expect(eml.text).not.toContain("<strong>");
    });

    it("lists attachment filenames without extracting their contents", async () => {
        // Multipart with one text body and one attachment.
        const boundary = "BOUNDARY42";
        const attachmentB64 = Buffer.from("PDF body bytes", "utf8").toString("base64");
        const multipart = [
            "From: a@x.com",
            "To: b@x.com",
            "Subject: With attachment",
            "Date: Mon, 11 May 2026 12:00:00 +0000",
            "MIME-Version: 1.0",
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            "See attached.",
            "",
            `--${boundary}`,
            "Content-Type: application/pdf; name=\"report.pdf\"",
            "Content-Disposition: attachment; filename=\"report.pdf\"",
            "Content-Transfer-Encoding: base64",
            "",
            attachmentB64,
            "",
            `--${boundary}--`,
            "",
        ].join("\r\n");
        const eml = await extractEml(emlBuf(multipart));
        expect(eml.text).toContain("See attached");
        expect(eml.attachments).toHaveLength(1);
        expect(eml.attachments[0].filename).toBe("report.pdf");
        expect(eml.attachments[0].contentType).toBe("application/pdf");
    });

    it("returns null for missing headers", async () => {
        const minimal = ["Subject: bare", "", "body only", ""].join("\r\n");
        const eml = await extractEml(emlBuf(minimal));
        expect(eml.from).toBeNull();
        expect(eml.to).toBeNull();
        expect(eml.cc).toBeNull();
        expect(eml.date).toBeNull();
    });
});

describe("emlToLLMText", () => {
    it("renders headers as a preamble followed by the body", async () => {
        const eml = await extractEml(emlBuf(SAMPLE_PLAIN));
        const text = emlToLLMText(eml);
        expect(text).toMatch(/^Subject: Lunch\?/m);
        expect(text).toMatch(/^From: /m);
        expect(text).toMatch(/^To: /m);
        expect(text).toContain("Want to grab lunch on Friday");
    });

    it("appends an attachments line when present", async () => {
        const eml = {
            subject: "x",
            from: null,
            to: null,
            cc: null,
            date: null,
            text: "body",
            attachments: [
                { filename: "a.pdf", contentType: "application/pdf" },
                { filename: "b.png", contentType: "image/png" },
            ],
        };
        const text = emlToLLMText(eml);
        expect(text).toMatch(/\[Attachments: a\.pdf, b\.png\]/);
    });
});
