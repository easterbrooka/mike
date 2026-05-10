import { describe, expect, it } from "vitest";
import { randomBytes } from "crypto";
import { CryptoError, open, parseHeader, seal } from "../aead";

function dek(): Buffer {
    return randomBytes(32);
}

async function resolverFor(d: Buffer) {
    return async (_dekId: number): Promise<Buffer> => d;
}

describe("aead.seal / aead.open", () => {
    it("round-trips ASCII plaintext", async () => {
        const k = dek();
        const env = seal("sk-ant-api03-AAAA", k, 1);
        const out = await open(env, await resolverFor(k));
        expect(out.toString("utf8")).toBe("sk-ant-api03-AAAA");
    });

    it("round-trips UTF-8 with emoji", async () => {
        const k = dek();
        const msg = "héllo 世界 🦀";
        const env = seal(msg, k, 1);
        const out = await open(env, await resolverFor(k));
        expect(out.toString("utf8")).toBe(msg);
    });

    it("round-trips an empty string", async () => {
        const k = dek();
        const env = seal("", k, 1);
        const out = await open(env, await resolverFor(k));
        expect(out.toString("utf8")).toBe("");
    });

    it("round-trips a 1 MB random buffer", async () => {
        const k = dek();
        const big = randomBytes(1024 * 1024);
        const env = seal(big, k, 42);
        const out = await open(env, await resolverFor(k));
        expect(out.equals(big)).toBe(true);
    });

    it("rejects a tampered ciphertext byte", async () => {
        const k = dek();
        const env = seal("hello world", k, 1);
        // Flip a bit in the ciphertext region (after the 17-byte header,
        // before the 16-byte tag).
        env[20] ^= 0x01;
        await expect(open(env, await resolverFor(k))).rejects.toThrow(
            CryptoError,
        );
    });

    it("rejects a tampered auth tag byte", async () => {
        const k = dek();
        const env = seal("hello world", k, 1);
        env[env.length - 1] ^= 0x01;
        await expect(open(env, await resolverFor(k))).rejects.toThrow(
            CryptoError,
        );
    });

    it("rejects a tampered IV byte", async () => {
        const k = dek();
        const env = seal("hello world", k, 1);
        env[10] ^= 0x01; // IV occupies bytes 5..16
        await expect(open(env, await resolverFor(k))).rejects.toThrow(
            CryptoError,
        );
    });

    it("rejects opening with the wrong DEK", async () => {
        const env = seal("hello world", dek(), 1);
        await expect(open(env, await resolverFor(dek()))).rejects.toThrow(
            CryptoError,
        );
    });

    it("rejects an unknown version byte", async () => {
        const k = dek();
        const env = seal("hello world", k, 1);
        env[0] = 0x02;
        await expect(open(env, await resolverFor(k))).rejects.toThrow(
            /unsupported envelope version/,
        );
    });

    it("rejects an envelope shorter than header + tag", async () => {
        const tooShort = Buffer.alloc(10);
        await expect(
            open(tooShort, await resolverFor(dek())),
        ).rejects.toThrow(/too short/);
    });

    it("two seals of the same plaintext produce different envelopes", () => {
        const k = dek();
        const a = seal("same", k, 1);
        const b = seal("same", k, 1);
        // IV is random per call, so envelopes differ.
        expect(a.equals(b)).toBe(false);
    });

    it("rejects a DEK of the wrong length", () => {
        expect(() => seal("hi", randomBytes(31), 1)).toThrow(/32 bytes/);
        expect(() => seal("hi", randomBytes(33), 1)).toThrow(/32 bytes/);
    });

    it("rejects out-of-range dekId", () => {
        const k = dek();
        expect(() => seal("hi", k, -1)).toThrow(/uint32/);
        expect(() => seal("hi", k, 0xffffffff + 1)).toThrow(/uint32/);
        expect(() => seal("hi", k, 1.5)).toThrow(/uint32/);
    });
});

describe("aead.parseHeader", () => {
    it("returns version + dekId for a valid envelope", () => {
        const env = seal("any", dek(), 12345);
        expect(parseHeader(env)).toEqual({ version: 1, dekId: 12345 });
    });

    it("preserves a large dekId across the BE encoding", () => {
        const env = seal("any", dek(), 0xdeadbeef);
        expect(parseHeader(env).dekId).toBe(0xdeadbeef);
    });
});
