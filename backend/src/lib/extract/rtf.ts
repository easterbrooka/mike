/**
 * Decompress + de-encapsulate the PidTagRtfCompressed stream from an
 * Outlook .msg file. When an email is composed in HTML mode and saved
 * as .msg, Outlook frequently leaves PidTagBody and PidTagBodyHtml
 * empty and stores the message body only inside this compressed-RTF
 * stream as RFC-2557 encapsulated HTML (\fromhtml1 marker).
 *
 * Pipeline:
 *   compressedRtf (Uint8Array)
 *     -> decompressRTF (LZ77-like)
 *     -> deEncapsulateSync
 *         -> mode: "html" → strip tags to get plain text
 *         -> mode: "text" → return as-is
 *     -> "" on any failure (caller falls back to empty body)
 */

import { decompressRTF } from "@kenjiuno/decompressrtf";
import { deEncapsulateSync } from "rtf-stream-parser";
import * as iconvLite from "iconv-lite";
import { stripHtml } from "./eml";

export function rtfCompressedToText(compressedRtf: Uint8Array): string {
    try {
        const decompressed = decompressRTF(Array.from(compressedRtf));
        const rtfBuf = Buffer.from(decompressed);
        const result = deEncapsulateSync(rtfBuf, {
            decode: iconvLite.decode,
        });
        const text = result.text;
        if (typeof text !== "string" || text.length === 0) return "";
        if (result.mode === "html") return stripHtml(text);
        return text;
    } catch {
        // Non-encapsulated RTF, corrupt compressedRtf, or any other
        // parse failure. The caller treats this as "no body" and the
        // headers + attachments still render — we don't want one weird
        // .msg to break the whole upload.
        return "";
    }
}
