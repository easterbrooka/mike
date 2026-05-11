import { describe, expect, it, vi } from "vitest";

const mockGetFileData = vi.hoisted(() => vi.fn());
const mockGetAttachment = vi.hoisted(() => vi.fn());
const mockRtfToText = vi.hoisted(() => vi.fn());

vi.mock("@kenjiuno/msgreader", () => ({
    default: vi.fn().mockImplementation(() => ({
        getFileData: mockGetFileData,
        getAttachment: mockGetAttachment,
    })),
}));
vi.mock("../rtf", () => ({
    rtfCompressedToText: mockRtfToText,
}));

import { extractMsg, extractMsgForLLM } from "../msg";

function emptyBuf(): ArrayBuffer {
    return new ArrayBuffer(0);
}

describe("extractMsg", () => {
    it("maps a fully-populated msg to the ParsedEml shape", async () => {
        mockGetFileData.mockReturnValue({
            subject: "Lunch?",
            senderName: "Alice",
            senderEmail: "alice@example.com",
            body: "Want to grab lunch?",
            messageDeliveryTime: "Mon, 11 May 2026 12:00:00 +0000",
            recipients: [
                { name: "Bob", email: "bob@example.com", recipType: "to" },
                { name: "Carol", email: "carol@example.com", recipType: "cc" },
                { name: "Dan", email: "dan@example.com", recipType: "to" },
            ],
            attachments: [
                { fileName: "report.pdf", attachMimeTag: "application/pdf" },
                { fileName: "logo.png", attachMimeTag: null },
            ],
        });
        const out = await extractMsg(emptyBuf());
        expect(out.subject).toBe("Lunch?");
        expect(out.from).toBe("Alice <alice@example.com>");
        expect(out.to).toBe("Bob <bob@example.com>, Dan <dan@example.com>");
        expect(out.cc).toBe("Carol <carol@example.com>");
        expect(out.date).toBe("2026-05-11T12:00:00.000Z");
        expect(out.text).toBe("Want to grab lunch?");
        expect(out.attachments).toEqual([
            { filename: "report.pdf", contentType: "application/pdf" },
            { filename: "logo.png", contentType: null },
        ]);
    });

    it("returns null for absent header fields rather than the string 'undefined'", async () => {
        mockGetFileData.mockReturnValue({});
        const out = await extractMsg(emptyBuf());
        expect(out.subject).toBeNull();
        expect(out.from).toBeNull();
        expect(out.to).toBeNull();
        expect(out.cc).toBeNull();
        expect(out.date).toBeNull();
        expect(out.text).toBe("");
        expect(out.attachments).toEqual([]);
    });

    it("uses email-only when senderName is missing", async () => {
        mockGetFileData.mockReturnValue({
            senderEmail: "bare@example.com",
        });
        expect((await extractMsg(emptyBuf())).from).toBe("bare@example.com");
    });

    it("does not duplicate when senderName equals senderEmail", async () => {
        mockGetFileData.mockReturnValue({
            senderName: "x@x.com",
            senderEmail: "x@x.com",
        });
        expect((await extractMsg(emptyBuf())).from).toBe("x@x.com");
    });

    it("drops attachments without a filename", async () => {
        mockGetFileData.mockReturnValue({
            attachments: [
                { fileName: "good.pdf", attachMimeTag: "application/pdf" },
                { attachMimeTag: "application/pdf" },
                { fileName: "", attachMimeTag: "application/pdf" },
            ],
        });
        const out = await extractMsg(emptyBuf());
        expect(out.attachments.map((a) => a.filename)).toEqual(["good.pdf"]);
    });

    it("returns null date on unparseable delivery time", async () => {
        mockGetFileData.mockReturnValue({
            messageDeliveryTime: "not a date",
        });
        expect((await extractMsg(emptyBuf())).date).toBeNull();
    });
});

describe("extractMsg body fallback", () => {
    it("uses bodyHtml (stripped) when plain-text body is empty", async () => {
        mockGetFileData.mockReturnValue({
            subject: "HTML-only body",
            bodyHtml:
                "<p>Hello <strong>team</strong></p><p>Please review.</p>",
        });
        const out = await extractMsg(emptyBuf());
        expect(out.text).toContain("Hello team");
        expect(out.text).toContain("Please review.");
        expect(out.text).not.toContain("<p>");
        expect(out.text).not.toContain("<strong>");
    });

    it("prefers plain-text body when both are present", async () => {
        mockGetFileData.mockReturnValue({
            body: "plain text wins",
            bodyHtml: "<p>html loses</p>",
        });
        expect((await extractMsg(emptyBuf())).text).toBe("plain text wins");
    });

    it("returns empty string when neither body nor bodyHtml is set", async () => {
        mockGetFileData.mockReturnValue({});
        mockRtfToText.mockReturnValue("");
        expect((await extractMsg(emptyBuf())).text).toBe("");
    });

    it("falls back to compressedRtf when body and bodyHtml are both empty", async () => {
        mockGetFileData.mockReturnValue({
            compressedRtf: new Uint8Array([1, 2, 3]),
        });
        mockRtfToText.mockReturnValue("Decoded from compressed RTF.");
        const out = await extractMsg(emptyBuf());
        expect(out.text).toBe("Decoded from compressed RTF.");
        expect(mockRtfToText).toHaveBeenCalled();
    });

    it("does not call rtfCompressedToText when bodyHtml is populated", async () => {
        mockRtfToText.mockClear();
        mockGetFileData.mockReturnValue({
            bodyHtml: "<p>html body wins</p>",
            compressedRtf: new Uint8Array([1, 2, 3]),
        });
        await extractMsg(emptyBuf());
        expect(mockRtfToText).not.toHaveBeenCalled();
    });
});

describe("extractMsg inner-msg attachment detection", () => {
    it("lists inner-msg attachments using name + .msg synthesised filename", async () => {
        mockGetFileData.mockReturnValue({
            attachments: [
                { fileName: "report.pdf", attachMimeTag: "application/pdf" },
                {
                    name: "Forwarded message",
                    innerMsgContent: true,
                },
            ],
        });
        const out = await extractMsg(emptyBuf());
        expect(out.attachments).toEqual([
            { filename: "report.pdf", contentType: "application/pdf" },
            { filename: "Forwarded message.msg", contentType: null },
        ]);
    });

    it("falls back to 'embedded.msg' for inner-msg attachments with no name", async () => {
        mockGetFileData.mockReturnValue({
            attachments: [{ innerMsgContent: true }],
        });
        expect((await extractMsg(emptyBuf())).attachments).toEqual([
            { filename: "embedded.msg", contentType: null },
        ]);
    });
});

describe("extractMsgForLLM", () => {
    it("inlines a .txt attachment's text via getAttachment(idx)", async () => {
        mockGetFileData.mockReturnValue({
            subject: "Hi",
            senderEmail: "a@x.com",
            body: "Please see attached.",
            attachments: [
                { fileName: "memo.txt", attachMimeTag: "text/plain" },
            ],
        });
        mockGetAttachment.mockReturnValue({
            fileName: "memo.txt",
            content: new TextEncoder().encode("Inline memo contents."),
        });
        const out = await extractMsgForLLM(emptyBuf());
        expect(out).toContain("Please see attached.");
        expect(out).toContain("--- Attachment: memo.txt ---");
        expect(out).toContain("Inline memo contents.");
    });

    it("skips a .png attachment but keeps it on the summary line", async () => {
        mockGetFileData.mockReturnValue({
            subject: "With image",
            body: "see logo",
            attachments: [
                { fileName: "logo.png", attachMimeTag: "image/png" },
            ],
        });
        mockGetAttachment.mockReturnValue({
            fileName: "logo.png",
            content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        });
        const out = await extractMsgForLLM(emptyBuf());
        expect(out).toMatch(/\[Attachments: logo\.png\]/);
        expect(out).not.toContain("--- Attachment: logo.png ---");
    });

    it("does not throw when there are no attachments", async () => {
        mockGetFileData.mockReturnValue({
            subject: "Plain",
            body: "no attachments here",
        });
        const out = await extractMsgForLLM(emptyBuf());
        expect(out).toContain("no attachments here");
        expect(out).not.toContain("--- Attachment:");
    });

    it("expands an inner-msg attachment recursively (synthesised .msg filename)", async () => {
        // Outer .msg has an embedded message; inner content is a plain
        // ASCII string that mocks the burned-msg bytes. Because the inner
        // bytes are NOT a real .msg, msgreader recursion will throw — but
        // the depth-1 extract should still produce the synthesised
        // `--- Attachment: ... ---` header with a "(could not extract)"
        // placeholder, which is enough to prove the dispatcher is invoked.
        mockGetFileData.mockReturnValue({
            subject: "Outer subject",
            body: "Outer body text.",
            attachments: [
                {
                    name: "Forwarded message",
                    innerMsgContent: true,
                },
            ],
        });
        mockGetAttachment.mockReturnValue({
            fileName: "Forwarded message.msg",
            content: new TextEncoder().encode("not-a-real-msg-payload"),
        });
        const out = await extractMsgForLLM(emptyBuf());
        expect(out).toContain("Outer body text.");
        expect(out).toMatch(/--- Attachment: Forwarded message\.msg ---/);
    });

    it("survives a getAttachment() failure for one attachment without dropping siblings", async () => {
        mockGetFileData.mockReturnValue({
            attachments: [
                { fileName: "bad.txt", attachMimeTag: "text/plain" },
                { fileName: "good.txt", attachMimeTag: "text/plain" },
            ],
        });
        let call = 0;
        mockGetAttachment.mockImplementation(() => {
            call += 1;
            if (call === 1) throw new Error("simulated inner-msg failure");
            return {
                fileName: "good.txt",
                content: new TextEncoder().encode("Sibling survived."),
            };
        });
        const out = await extractMsgForLLM(emptyBuf());
        expect(out).not.toContain("--- Attachment: bad.txt ---");
        expect(out).toContain("--- Attachment: good.txt ---");
        expect(out).toContain("Sibling survived.");
    });
});
