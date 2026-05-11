/**
 * Throwaway diagnostic: show which body fields msgreader populates for
 * a given .msg, and exercise the RTF decompress + de-encapsulate path
 * step by step so we can see exactly where the body extraction is
 * dropping content.
 */

import * as fs from "node:fs";
import MsgReader from "@kenjiuno/msgreader";
import { decompressRTF } from "@kenjiuno/decompressrtf";
import { deEncapsulateSync } from "rtf-stream-parser";
import * as iconvLite from "iconv-lite";

const filePath = process.argv[2];
if (!filePath) {
    console.error("Usage: npx tsx scripts/debug-msg.ts <path-to-msg>");
    process.exit(2);
}

const buf = fs.readFileSync(filePath);
const ab = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
) as ArrayBuffer;

const reader = new MsgReader(ab);
const data = reader.getFileData() as Record<string, unknown>;

const bodyFields = ["body", "bodyHtml", "compressedRtf"] as const;
console.log("=== body-related fields present ===");
for (const f of bodyFields) {
    const v = data[f];
    if (v === undefined) {
        console.log(`  ${f}: <missing>`);
    } else if (typeof v === "string") {
        console.log(`  ${f}: string, length=${v.length}, first 120 chars: ${JSON.stringify(v.slice(0, 120))}`);
    } else if (v instanceof Uint8Array) {
        console.log(`  ${f}: Uint8Array, length=${v.length}`);
    } else {
        console.log(`  ${f}: ${typeof v}`);
    }
}

if (data.compressedRtf instanceof Uint8Array) {
    console.log("\n=== attempting RTF decompress ===");
    try {
        const decompressed = decompressRTF(Array.from(data.compressedRtf));
        const rtfBuf = Buffer.from(decompressed);
        console.log(`decompressed length=${rtfBuf.length}`);
        console.log(`first 400 chars of RTF:\n${rtfBuf.toString("latin1").slice(0, 400)}`);

        console.log("\n=== attempting deEncapsulateSync ===");
        try {
            const result = deEncapsulateSync(rtfBuf, {
                decode: iconvLite.decode,
            });
            console.log(`mode: ${result.mode}`);
            const textLen =
                typeof result.text === "string" ? result.text.length : -1;
            console.log(`text length: ${textLen}`);
            if (typeof result.text === "string") {
                console.log(`first 400 chars of de-encapsulated text:\n${result.text.slice(0, 400)}`);
            }
        } catch (e) {
            console.log(`deEncapsulateSync threw: ${(e as Error).message}`);
        }
    } catch (e) {
        console.log(`decompressRTF threw: ${(e as Error).message}`);
    }
}

console.log("\n=== other top-level fields ===");
const skip = new Set(["body", "bodyHtml", "compressedRtf", "attachments", "recipients"]);
const otherKeys = Object.keys(data).filter((k) => !skip.has(k));
for (const k of otherKeys) {
    const v = data[k];
    if (typeof v === "string") {
        const preview = v.length > 100 ? v.slice(0, 100) + "..." : v;
        console.log(`  ${k}: ${JSON.stringify(preview)}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
        console.log(`  ${k}: ${v}`);
    } else if (v instanceof Uint8Array) {
        console.log(`  ${k}: Uint8Array(${v.length})`);
    } else {
        console.log(`  ${k}: <${typeof v}>`);
    }
}
