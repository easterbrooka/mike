import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above all const declarations, so we use vi.hoisted() to
// define the fakes in the same hoisted phase. This way the factory below can
// reference them.
const { sendMock, FakeKMSClient, FakeGenerateDataKeyCommand, FakeDecryptCommand } = vi.hoisted(() => {
    const sendMock = vi.fn();
    class FakeKMSClient {
        send = sendMock;
    }
    class FakeGenerateDataKeyCommand {
        constructor(public input: unknown) {}
    }
    class FakeDecryptCommand {
        constructor(public input: unknown) {}
    }
    return { sendMock, FakeKMSClient, FakeGenerateDataKeyCommand, FakeDecryptCommand };
});

vi.mock("@aws-sdk/client-kms", () => ({
    KMSClient: FakeKMSClient,
    GenerateDataKeyCommand: FakeGenerateDataKeyCommand,
    DecryptCommand: FakeDecryptCommand,
}));

import {
    _resetKmsClientForTests,
    assertKmsConfigured,
    generateDek,
    unwrapDek,
} from "../kms";

describe("kms.generateDek", () => {
    let savedKeyId: string | undefined;

    beforeEach(() => {
        savedKeyId = process.env.KMS_KEY_ID;
        process.env.KMS_KEY_ID = "alias/mike-app-data";
        _resetKmsClientForTests();
        sendMock.mockReset();
    });

    afterEach(() => {
        if (savedKeyId === undefined) delete process.env.KMS_KEY_ID;
        else process.env.KMS_KEY_ID = savedKeyId;
        _resetKmsClientForTests();
    });

    it("forwards KeyId from KMS_KEY_ID and returns plaintext + wrapped + ARN", async () => {
        sendMock.mockResolvedValueOnce({
            Plaintext: new Uint8Array(32).fill(0xab),
            CiphertextBlob: Buffer.from("wrapped-blob"),
            KeyId: "arn:aws:kms:ap-southeast-2:111:key/abc",
        });

        const out = await generateDek();

        expect(sendMock).toHaveBeenCalledTimes(1);
        const cmd = sendMock.mock.calls[0]![0] as FakeGenerateDataKeyCommand;
        expect(cmd).toBeInstanceOf(FakeGenerateDataKeyCommand);
        expect(cmd.input).toEqual({
            KeyId: "alias/mike-app-data",
            KeySpec: "AES_256",
        });
        expect(out.plaintext.length).toBe(32);
        expect(out.plaintext.equals(Buffer.alloc(32, 0xab))).toBe(true);
        expect(out.wrapped.wrapped.toString("utf8")).toBe("wrapped-blob");
        expect(out.wrapped.kmsKeyArn).toBe(
            "arn:aws:kms:ap-southeast-2:111:key/abc",
        );
    });

    it("throws if KMS returns a partial response", async () => {
        sendMock.mockResolvedValueOnce({
            Plaintext: new Uint8Array(32),
            // missing CiphertextBlob
            KeyId: "arn:...",
        });
        await expect(generateDek()).rejects.toThrow(/missing/);
    });

    it("throws if KMS_KEY_ID is unset", async () => {
        delete process.env.KMS_KEY_ID;
        _resetKmsClientForTests();
        await expect(generateDek()).rejects.toThrow(/KMS_KEY_ID/);
    });
});

describe("kms.unwrapDek", () => {
    beforeEach(() => {
        process.env.KMS_KEY_ID = "alias/mike-app-data";
        _resetKmsClientForTests();
        sendMock.mockReset();
    });

    it("calls Decrypt with CiphertextBlob and returns 32-byte plaintext", async () => {
        const wrapped = Buffer.from("wrapped");
        sendMock.mockResolvedValueOnce({
            Plaintext: new Uint8Array(32).fill(0xcd),
        });

        const out = await unwrapDek(wrapped);

        expect(sendMock).toHaveBeenCalledTimes(1);
        const cmd = sendMock.mock.calls[0]![0] as FakeDecryptCommand;
        expect(cmd).toBeInstanceOf(FakeDecryptCommand);
        expect(cmd.input).toEqual({ CiphertextBlob: wrapped });
        expect(out.length).toBe(32);
        expect(out.equals(Buffer.alloc(32, 0xcd))).toBe(true);
    });

    it("throws if KMS returns no Plaintext", async () => {
        sendMock.mockResolvedValueOnce({});
        await expect(unwrapDek(Buffer.from("x"))).rejects.toThrow(
            /no Plaintext/,
        );
    });

    it("throws if KMS returns a wrong-sized DEK", async () => {
        sendMock.mockResolvedValueOnce({
            Plaintext: new Uint8Array(16),
        });
        await expect(unwrapDek(Buffer.from("x"))).rejects.toThrow(
            /32-byte DEK/,
        );
    });
});

describe("kms.assertKmsConfigured", () => {
    it("throws if KMS_KEY_ID is unset", () => {
        const saved = process.env.KMS_KEY_ID;
        delete process.env.KMS_KEY_ID;
        expect(() => assertKmsConfigured()).toThrow(/KMS_KEY_ID/);
        if (saved !== undefined) process.env.KMS_KEY_ID = saved;
    });

    it("does not throw when KMS_KEY_ID is set", () => {
        process.env.KMS_KEY_ID = "alias/x";
        expect(() => assertKmsConfigured()).not.toThrow();
    });
});
