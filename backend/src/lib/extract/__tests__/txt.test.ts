import { describe, expect, it } from "vitest";
import { extractTxt, txtToLLMText } from "../txt";

function buf(s: string): ArrayBuffer {
    const b = Buffer.from(s, "utf8");
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe("extractTxt", () => {
    it("decodes plain ASCII", () => {
        expect(extractTxt(buf("hello world"))).toBe("hello world");
    });

    it("decodes UTF-8 with non-ASCII characters", () => {
        expect(extractTxt(buf("héllo 世界 🦀"))).toBe("héllo 世界 🦀");
    });

    it("strips a leading UTF-8 BOM", () => {
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const body = Buffer.from("after-bom", "utf8");
        const combined = Buffer.concat([bom, body]);
        const ab = combined.buffer.slice(
            combined.byteOffset,
            combined.byteOffset + combined.byteLength,
        ) as ArrayBuffer;
        expect(extractTxt(ab)).toBe("after-bom");
    });

    it("returns an empty string for an empty buffer", () => {
        expect(extractTxt(buf(""))).toBe("");
    });

    it("preserves CRLF line endings as-is", () => {
        expect(extractTxt(buf("a\r\nb\r\nc"))).toBe("a\r\nb\r\nc");
    });
});

describe("txtToLLMText", () => {
    it("returns short text unchanged", () => {
        expect(txtToLLMText("short")).toBe("short");
    });

    it("truncates and signposts when over the cap", () => {
        const big = "x".repeat(250_000);
        const out = txtToLLMText(big);
        expect(out.length).toBeLessThan(big.length);
        expect(out).toMatch(/truncated at .* characters/);
    });
});
