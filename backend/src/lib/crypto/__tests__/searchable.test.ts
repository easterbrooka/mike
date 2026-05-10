import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    _resetPepperCacheForTests,
    emailIndex,
    normaliseEmail,
} from "../searchable";

const TEST_PEPPER =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_PEPPER =
    "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("searchable.normaliseEmail", () => {
    it("lowercases and trims", () => {
        expect(normaliseEmail("  Alice@X.COM  ")).toBe("alice@x.com");
    });

    it("does not strip plus-tags or dots", () => {
        // Deliberate: we mirror what users type when sharing, not Gmail's
        // canonicalisation. "alice+work@x.com" is treated as distinct from
        // "alice@x.com" because that's what the sharer typed.
        expect(normaliseEmail("Alice+work@X.com")).toBe("alice+work@x.com");
    });
});

describe("searchable.emailIndex", () => {
    let savedPepper: string | undefined;

    beforeEach(() => {
        savedPepper = process.env.EMAIL_HMAC_PEPPER;
        process.env.EMAIL_HMAC_PEPPER = TEST_PEPPER;
        _resetPepperCacheForTests();
    });

    afterEach(() => {
        if (savedPepper === undefined) {
            delete process.env.EMAIL_HMAC_PEPPER;
        } else {
            process.env.EMAIL_HMAC_PEPPER = savedPepper;
        }
        _resetPepperCacheForTests();
    });

    it("returns a 32-byte digest", () => {
        const idx = emailIndex("alice@x.com");
        expect(idx.length).toBe(32);
    });

    it("is deterministic across normalisation differences", () => {
        const a = emailIndex("Alice@X.COM");
        const b = emailIndex("  alice@x.com  ");
        expect(a.equals(b)).toBe(true);
    });

    it("produces different digests for different emails", () => {
        const a = emailIndex("alice@x.com");
        const b = emailIndex("bob@x.com");
        expect(a.equals(b)).toBe(false);
    });

    it("changes when the pepper changes", () => {
        const a = emailIndex("alice@x.com");
        process.env.EMAIL_HMAC_PEPPER = OTHER_PEPPER;
        _resetPepperCacheForTests();
        const b = emailIndex("alice@x.com");
        expect(a.equals(b)).toBe(false);
    });

    it("throws if EMAIL_HMAC_PEPPER is unset", () => {
        delete process.env.EMAIL_HMAC_PEPPER;
        _resetPepperCacheForTests();
        expect(() => emailIndex("alice@x.com")).toThrow(
            /EMAIL_HMAC_PEPPER must be set/,
        );
    });

    it("throws if EMAIL_HMAC_PEPPER is the wrong length", () => {
        process.env.EMAIL_HMAC_PEPPER = "abcd";
        _resetPepperCacheForTests();
        expect(() => emailIndex("alice@x.com")).toThrow(/64 hex chars/);
    });

    it("throws if EMAIL_HMAC_PEPPER has non-hex chars", () => {
        process.env.EMAIL_HMAC_PEPPER = "Z".repeat(64);
        _resetPepperCacheForTests();
        expect(() => emailIndex("alice@x.com")).toThrow(/64 hex chars/);
    });
});
