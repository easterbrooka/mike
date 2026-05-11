import { describe, expect, it, vi } from "vitest";

const mockGetFileData = vi.hoisted(() => vi.fn());

vi.mock("@kenjiuno/msgreader", () => ({
    default: vi.fn().mockImplementation(() => ({
        getFileData: mockGetFileData,
    })),
}));

import { extractMsg } from "../msg";

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
