import { describe, expect, it, vi } from "vitest";

const mockDecompress = vi.hoisted(() => vi.fn());
const mockDeEncapsulate = vi.hoisted(() => vi.fn());

vi.mock("@kenjiuno/decompressrtf", () => ({
    decompressRTF: mockDecompress,
}));
vi.mock("rtf-stream-parser", () => ({
    deEncapsulateSync: mockDeEncapsulate,
}));

import { rtfCompressedToText } from "../rtf";

function compressedBytes(): Uint8Array {
    // Content is irrelevant — decompressRTF is mocked.
    return new Uint8Array([1, 2, 3, 4]);
}

describe("rtfCompressedToText", () => {
    it("returns plain text directly when de-encapsulation reports text mode", () => {
        mockDecompress.mockReturnValue([0x7b, 0x5c, 0x72]);
        mockDeEncapsulate.mockReturnValue({
            mode: "text",
            text: "Just a plain message body.",
        });
        expect(rtfCompressedToText(compressedBytes())).toBe(
            "Just a plain message body.",
        );
    });

    it("strips tags when de-encapsulation reports html mode", () => {
        mockDecompress.mockReturnValue([0x7b]);
        mockDeEncapsulate.mockReturnValue({
            mode: "html",
            text: "<p>Hello <strong>world</strong></p><p>Second paragraph</p>",
        });
        const out = rtfCompressedToText(compressedBytes());
        expect(out).toContain("Hello world");
        expect(out).toContain("Second paragraph");
        expect(out).not.toContain("<p>");
        expect(out).not.toContain("<strong>");
    });

    it("returns empty string when de-encapsulation yields empty text", () => {
        mockDecompress.mockReturnValue([0x7b]);
        mockDeEncapsulate.mockReturnValue({ mode: "text", text: "" });
        expect(rtfCompressedToText(compressedBytes())).toBe("");
    });

    it("returns empty string when de-encapsulation throws (non-encapsulated RTF)", () => {
        mockDecompress.mockReturnValue([0x7b]);
        mockDeEncapsulate.mockImplementation(() => {
            throw new Error("Not RTF-encapsulated content");
        });
        expect(rtfCompressedToText(compressedBytes())).toBe("");
    });

    it("returns empty string when decompression throws (corrupt compressedRtf)", () => {
        mockDecompress.mockImplementation(() => {
            throw new Error("bad header");
        });
        expect(rtfCompressedToText(compressedBytes())).toBe("");
    });
});
