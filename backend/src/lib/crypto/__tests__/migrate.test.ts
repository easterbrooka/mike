import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted; define the fakes inside vi.hoisted so the factory
// below can reference them.
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

import type { SupabaseClient } from "@supabase/supabase-js";
import { _resetKmsClientForTests } from "../kms";
import {
    bufferToBytea,
    byteaToBuffer,
    ensureUserHasDek,
    tenantCrypto,
} from "../migrate";

// ----- Fake Supabase ----------------------------------------------------

interface DekRow {
    id: number;
    user_id: string;
    kms_key_arn: string;
    wrapped_dek: Buffer;
    is_active: boolean;
}

class FakeSupabase {
    private rows: DekRow[] = [];
    private nextId = 1;

    from(table: string) {
        if (table !== "tenant_deks") {
            throw new Error(`FakeSupabase: unexpected table ${table}`);
        }
        return new TenantDeksQuery(this);
    }

    _all(): DekRow[] {
        return this.rows;
    }
    _insert(partial: Omit<DekRow, "id">): DekRow {
        const row: DekRow = { id: this.nextId++, ...partial };
        this.rows.push(row);
        return row;
    }
    _findById(id: number): DekRow | undefined {
        return this.rows.find((r) => r.id === id);
    }
    _findActive(userId: string): DekRow | undefined {
        return this.rows.find((r) => r.user_id === userId && r.is_active);
    }
}

class TenantDeksQuery {
    private filters: Record<string, unknown> = {};
    private mode: "select" | "insert" = "select";
    private insertPayload: Omit<DekRow, "id"> | null = null;

    constructor(private db: FakeSupabase) {}

    select(_cols: string) {
        return this;
    }
    eq(col: string, val: unknown) {
        this.filters[col] = val;
        return this;
    }
    insert(payload: {
        user_id: string;
        kms_key_arn: string;
        wrapped_dek: unknown;
        is_active: boolean;
    }) {
        // Real PostgREST rejects raw Buffer (JSON.stringify-s to
        // {"type":"Buffer",...}); callers must pre-encode with bufferToBytea.
        // Mirror that contract so tests catch any regression where a Buffer
        // sneaks through.
        if (typeof payload.wrapped_dek !== "string" || !payload.wrapped_dek.startsWith("\\x")) {
            throw new Error(
                `FakeSupabase.insert: wrapped_dek must be a \\x-prefixed hex string (got ${typeof payload.wrapped_dek})`,
            );
        }
        this.mode = "insert";
        this.insertPayload = {
            user_id: payload.user_id,
            kms_key_arn: payload.kms_key_arn,
            wrapped_dek: Buffer.from(payload.wrapped_dek.slice(2), "hex"),
            is_active: payload.is_active,
        };
        return this;
    }
    async single() {
        if (this.mode === "insert") {
            const row = this.db._insert(this.insertPayload!);
            return { data: row, error: null };
        }
        const id = this.filters.id as number | undefined;
        if (id !== undefined) {
            const row = this.db._findById(id);
            if (!row) return { data: null, error: { message: "no row", code: "PGRST116" } };
            return {
                data: { id: row.id, wrapped_dek: "\\x" + row.wrapped_dek.toString("hex") },
                error: null,
            };
        }
        throw new Error("FakeSupabase.single: only id-based select supported");
    }
    async maybeSingle() {
        const userId = this.filters.user_id as string | undefined;
        const isActive = this.filters.is_active as boolean | undefined;
        if (userId !== undefined) {
            const row = this.db._findActive(userId);
            if (!row || isActive === false) {
                return { data: null, error: null };
            }
            return {
                data: {
                    id: row.id,
                    wrapped_dek: "\\x" + row.wrapped_dek.toString("hex"),
                    is_active: row.is_active,
                },
                error: null,
            };
        }
        throw new Error("FakeSupabase.maybeSingle: only user-based select supported");
    }
}

// ----- Helpers ----------------------------------------------------------

function setupKmsMock() {
    sendMock.mockReset();

    // Return a deterministic plaintext per call so tests can verify.
    const dekByteByCall = [0xaa, 0xbb, 0xcc, 0xdd];
    let genCallCount = 0;
    sendMock.mockImplementation((cmd: unknown) => {
        if (cmd instanceof FakeGenerateDataKeyCommand) {
            const fillByte = dekByteByCall[genCallCount % dekByteByCall.length]!;
            genCallCount += 1;
            return Promise.resolve({
                Plaintext: new Uint8Array(32).fill(fillByte),
                CiphertextBlob: Buffer.from(`wrapped-${fillByte.toString(16)}`),
                KeyId: "arn:aws:kms:ap-southeast-2:111:key/abc",
            });
        }
        if (cmd instanceof FakeDecryptCommand) {
            // The wrapped blob format is "wrapped-<hex byte>"; reverse to get
            // the original fill byte so the unwrapped DEK matches what was
            // generated.
            const blob = (cmd.input as { CiphertextBlob: Buffer }).CiphertextBlob;
            const tail = blob.toString("utf8").split("-")[1] ?? "00";
            const fillByte = parseInt(tail, 16);
            return Promise.resolve({
                Plaintext: new Uint8Array(32).fill(fillByte),
            });
        }
        throw new Error(`unexpected command: ${cmd}`);
    });
}

beforeEach(() => {
    process.env.KMS_KEY_ID = "alias/mike-app-data";
    _resetKmsClientForTests();
    setupKmsMock();
});

afterEach(() => {
    delete process.env.KMS_KEY_ID;
});

// ----- Tests ------------------------------------------------------------

describe("tenantCrypto.sealForUser + open round-trip", () => {
    it("mints a DEK on first call, reuses on second", async () => {
        const db = new FakeSupabase();
        const tc = tenantCrypto(db as unknown as SupabaseClient);

        const env1 = await tc.sealForUser("user-1", "secret-1");
        const env2 = await tc.sealForUser("user-1", "secret-2");

        // GenerateDataKeyCommand called once (one DEK minted),
        // unwrap not called (we cached the plaintext on insert).
        const genCalls = sendMock.mock.calls.filter(
            (c) => c[0] instanceof FakeGenerateDataKeyCommand,
        );
        const decryptCalls = sendMock.mock.calls.filter(
            (c) => c[0] instanceof FakeDecryptCommand,
        );
        expect(genCalls.length).toBe(1);
        expect(decryptCalls.length).toBe(0);

        const out1 = await tc.open(env1);
        const out2 = await tc.open(env2);
        expect(out1).toBe("secret-1");
        expect(out2).toBe("secret-2");
    });

    it("opens an envelope sealed for one user from a fresh TenantCrypto", async () => {
        const db = new FakeSupabase();
        const tc1 = tenantCrypto(db as unknown as SupabaseClient);
        const env = await tc1.sealForUser("user-A", "alpha");

        // New TenantCrypto with empty cache, same DB.
        const tc2 = tenantCrypto(db as unknown as SupabaseClient);
        const out = await tc2.open(env);
        expect(out).toBe("alpha");

        // tc2 had to call KMS Decrypt once to unwrap.
        const decryptCalls = sendMock.mock.calls.filter(
            (c) => c[0] instanceof FakeDecryptCommand,
        );
        expect(decryptCalls.length).toBe(1);
    });

    it("each user gets a distinct DEK", async () => {
        const db = new FakeSupabase();
        const tc = tenantCrypto(db as unknown as SupabaseClient);

        await tc.sealForUser("user-1", "x");
        await tc.sealForUser("user-2", "y");

        expect(db._all().length).toBe(2);
        expect(db._all()[0]!.user_id).toBe("user-1");
        expect(db._all()[1]!.user_id).toBe("user-2");
        expect(db._all()[0]!.id).not.toBe(db._all()[1]!.id);
    });

    it("can open across user boundaries (workflow_shares list use case)", async () => {
        const db = new FakeSupabase();
        const tc = tenantCrypto(db as unknown as SupabaseClient);

        const envA = await tc.sealForUser("user-A", "A's email");
        const envB = await tc.sealForUser("user-B", "B's email");

        // Same TenantCrypto instance; both DEKs are now cached. open() picks
        // the right DEK by dek_id from the envelope header.
        const decryptBefore = sendMock.mock.calls.filter(
            (c) => c[0] instanceof FakeDecryptCommand,
        ).length;
        expect(await tc.open(envA)).toBe("A's email");
        expect(await tc.open(envB)).toBe("B's email");
        // Cached on insert, so opens shouldn't trigger KMS Decrypts at all.
        const decryptAfter = sendMock.mock.calls.filter(
            (c) => c[0] instanceof FakeDecryptCommand,
        ).length;
        expect(decryptAfter).toBe(decryptBefore);
    });

    it("DEK cache: opening twice with same dek_id calls KMS Decrypt at most once", async () => {
        const db = new FakeSupabase();
        const tc1 = tenantCrypto(db as unknown as SupabaseClient);
        const env = await tc1.sealForUser("user-1", "hello");

        const tc2 = tenantCrypto(db as unknown as SupabaseClient);
        await tc2.open(env);
        await tc2.open(env);

        const decryptCalls = sendMock.mock.calls.filter(
            (c) => c[0] instanceof FakeDecryptCommand,
        );
        expect(decryptCalls.length).toBe(1);
    });
});

describe("tenantCrypto.sealNullable", () => {
    it("returns null for null, undefined, and empty string", async () => {
        const db = new FakeSupabase();
        const tc = tenantCrypto(db as unknown as SupabaseClient);

        expect(await tc.sealNullable("user", null)).toBeNull();
        expect(await tc.sealNullable("user", undefined)).toBeNull();
        expect(await tc.sealNullable("user", "")).toBeNull();
        // No DEK should have been minted for the null cases.
        expect(db._all().length).toBe(0);
    });

    it("seals a non-empty value", async () => {
        const db = new FakeSupabase();
        const tc = tenantCrypto(db as unknown as SupabaseClient);
        const env = await tc.sealNullable("user", "value");
        expect(env).not.toBeNull();
        expect(await tc.open(env!)).toBe("value");
    });
});

describe("bufferToBytea / byteaToBuffer", () => {
    it("round-trips arbitrary bytes through the \\x-hex wire format", () => {
        const original = Buffer.from([0x00, 0xff, 0x10, 0xab, 0xcd, 0xef, 0x42, 0x7f]);
        const encoded = bufferToBytea(original);
        expect(encoded.startsWith("\\x")).toBe(true);
        expect(encoded).toBe("\\x00ff10abcdef427f");
        expect(byteaToBuffer(encoded).equals(original)).toBe(true);
    });

    it("encoded value is JSON-safe (postgrest-js stringifies bodies)", () => {
        // Regression: a raw Buffer would JSON.stringify to
        // {"type":"Buffer","data":[...]}, which bytea rejects. The encoded
        // string must survive stringify -> parse unchanged.
        const original = Buffer.from("hello", "utf8");
        const encoded = bufferToBytea(original);
        const roundTrip = JSON.parse(JSON.stringify({ col: encoded })).col;
        expect(roundTrip).toBe("\\x68656c6c6f");
        expect(byteaToBuffer(roundTrip).toString("utf8")).toBe("hello");
    });

    it("documents why bufferToBytea is required: raw Buffer JSON-stringifies to a shape bytea rejects", () => {
        // This test exists as living documentation of the bug that bufferToBytea
        // fixes. supabase-js builds request bodies with JSON.stringify (see
        // postgrest-js/src/PostgrestBuilder.ts), so any raw Buffer value
        // becomes {"type":"Buffer","data":[...]} on the wire — which PostgREST
        // cannot coerce to a bytea column. Always wrap Buffer values with
        // bufferToBytea before they reach a .insert / .update / .upsert /
        // .eq call against a bytea column.
        const buf = Buffer.from([0x12, 0x34, 0xab]);
        const serialised = JSON.parse(JSON.stringify({ col: buf }));
        expect(typeof serialised.col).toBe("object");
        expect(serialised.col).toEqual({ type: "Buffer", data: [0x12, 0x34, 0xab] });
        // The fix:
        expect(JSON.parse(JSON.stringify({ col: bufferToBytea(buf) })).col).toBe(
            "\\x1234ab",
        );
    });

    it("FakeSupabase rejects raw Buffer on insert (matches real PostgREST contract)", () => {
        // Belt-and-braces regression guard. If a future call site forgets
        // bufferToBytea and passes a Buffer to .insert(), the FakeSupabase
        // throws — mirroring what real PostgREST would do — instead of
        // silently storing a value the tests would have otherwise accepted.
        const db = new FakeSupabase();
        const builder = db.from("tenant_deks") as unknown as {
            insert: (p: {
                user_id: string;
                kms_key_arn: string;
                wrapped_dek: unknown;
                is_active: boolean;
            }) => unknown;
        };
        expect(() =>
            builder.insert({
                user_id: "u",
                kms_key_arn: "k",
                wrapped_dek: Buffer.from([0xaa, 0xbb]),
                is_active: true,
            })
        ).toThrow(/\\x-prefixed hex string/);
    });
});

describe("ensureUserHasDek", () => {
    it("creates a DEK if none exists", async () => {
        const db = new FakeSupabase();
        const result = await ensureUserHasDek(
            db as unknown as SupabaseClient,
            "user-new",
        );
        expect(result.dekId).toBeGreaterThan(0);
        expect(result.dek.length).toBe(32);
        expect(db._findActive("user-new")).toBeDefined();
    });

    it("returns the existing DEK if user already has one", async () => {
        const db = new FakeSupabase();
        const first = await ensureUserHasDek(
            db as unknown as SupabaseClient,
            "user-x",
        );
        const second = await ensureUserHasDek(
            db as unknown as SupabaseClient,
            "user-x",
        );
        expect(second.dekId).toBe(first.dekId);
        expect(second.dek.equals(first.dek)).toBe(true);
        expect(db._all().length).toBe(1);
    });
});
