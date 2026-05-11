/**
 * Renders an email attachment's bytes to text for inclusion in the LLM
 * view of an .eml or .msg. UI behaviour (the /display endpoint, the
 * attachment-chip strip in EmlView) is unaffected — this module only
 * affects what `read_document` returns.
 *
 * Skipped (silently): inline images, executables, archives, and any
 * other suffix not in the extract-and-show set. Extraction errors are
 * caught per-attachment so one bad PDF doesn't break the whole email.
 */

import { extractTxt } from "./txt";
import { extractXlsx, xlsxToLLMText } from "./xlsx";

export const MAX_PER_ATTACHMENT_CHARS = 50_000;
export const MAX_TOTAL_ATTACHMENT_CHARS = 400_000;
export const MAX_RECURSION_DEPTH = 3;

const IMAGE_SUFFIXES = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "bmp",
    "svg",
    "webp",
    "ico",
    "tif",
    "tiff",
]);

const TEXT_EXTRACTABLE = new Set([
    "pdf",
    "docx",
    "doc",
    "txt",
    "xlsx",
    "eml",
    "msg",
]);

export interface AttachmentInput {
    filename: string;
    bytes: Buffer;
}

/**
 * Expand attachment bytes into a single LLM-facing string.
 *
 * - Returns `null` when the attachment is a skipped type (image, archive,
 *   anything not in TEXT_EXTRACTABLE). The caller is expected to omit
 *   the section entirely in that case.
 * - Returns a string with a leading `--- Attachment: <name> ---\n` header
 *   plus the extracted text (capped at MAX_PER_ATTACHMENT_CHARS).
 * - On extraction error, returns a `(could not extract …)` placeholder.
 * - When the attachment is itself an .eml or .msg and `depth` has not hit
 *   the recursion ceiling, the result is the *full* nested email
 *   rendering — body, headers, and any expanded grandchildren.
 *
 * Lazy-imports the heavy parsers (.pdf, .docx, .eml, .msg) to keep the
 * cold-start path lean.
 */
export async function expandAttachmentText(
    attachment: AttachmentInput,
    depth: number,
): Promise<string | null> {
    const suffix = suffixOf(attachment.filename);
    if (!suffix) return null;
    if (IMAGE_SUFFIXES.has(suffix)) return null;
    if (!TEXT_EXTRACTABLE.has(suffix)) return null;

    const header = `--- Attachment: ${attachment.filename} ---\n`;
    try {
        const body = await extractByType(suffix, attachment.bytes, depth);
        if (body === null) return null;
        const capped = capText(body, MAX_PER_ATTACHMENT_CHARS);
        return header + capped + "\n";
    } catch (err) {
        return `${header}(could not extract: ${(err as Error).message})\n`;
    }
}

async function extractByType(
    suffix: string,
    bytes: Buffer,
    depth: number,
): Promise<string | null> {
    const ab = bufferToArrayBuffer(bytes);
    switch (suffix) {
        case "txt":
            return extractTxt(ab);
        case "pdf":
            return pdfBytesToText(ab);
        case "docx":
        case "doc": {
            const mammoth = await import("mammoth");
            const result = await mammoth.extractRawText({ buffer: bytes });
            return result.value;
        }
        case "xlsx": {
            const wb = await extractXlsx(ab);
            return xlsxToLLMText(wb);
        }
        case "eml": {
            if (depth >= MAX_RECURSION_DEPTH) {
                return "(nested email — max recursion depth reached, not expanded)";
            }
            const { extractEmlForLLM } = await import("./eml");
            return extractEmlForLLM(ab, depth + 1);
        }
        case "msg": {
            if (depth >= MAX_RECURSION_DEPTH) {
                return "(nested email — max recursion depth reached, not expanded)";
            }
            const { extractMsgForLLM } = await import("./msg");
            return extractMsgForLLM(ab, depth + 1);
        }
        default:
            return null;
    }
}

/**
 * Renders a sequence of attachments as a single block of text, applying
 * MAX_TOTAL_ATTACHMENT_CHARS across the whole block. Once the cap is hit
 * remaining attachments are summarised as "(omitted)" so the LLM knows
 * something exists but won't try to quote from it.
 */
export async function renderAttachments(
    attachments: AttachmentInput[],
    depth: number,
): Promise<string> {
    if (attachments.length === 0) return "";
    const parts: string[] = [];
    let remaining = MAX_TOTAL_ATTACHMENT_CHARS;
    let omitted = 0;

    for (const att of attachments) {
        if (remaining <= 0) {
            omitted += 1;
            continue;
        }
        const expanded = await expandAttachmentText(att, depth);
        if (expanded === null) continue;
        if (expanded.length > remaining) {
            parts.push(
                expanded.slice(0, remaining) +
                    `\n[…attachment block truncated at ${MAX_TOTAL_ATTACHMENT_CHARS.toLocaleString()} chars]`,
            );
            remaining = 0;
        } else {
            parts.push(expanded);
            remaining -= expanded.length;
        }
    }

    if (omitted > 0) {
        parts.push(`(${omitted} further attachment(s) omitted — total cap reached)`);
    }
    return parts.join("\n");
}

function suffixOf(filename: string): string {
    const i = filename.lastIndexOf(".");
    return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

function capText(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n\n[…attachment truncated at ${max.toLocaleString()} chars]`;
}

function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
}

/**
 * Local PDF→plain-text extractor. Mirrors the pattern already in
 * routes/tabular.ts (extractPdfMarkdown) and routes/documents.ts; kept
 * private here to avoid a shared module that would currently have
 * exactly one caller.
 */
async function pdfBytesToText(buf: ArrayBuffer): Promise<string> {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
        pdfjsLib as unknown as {
            getDocument: (opts: unknown) => {
                promise: Promise<{
                    numPages: number;
                    getPage: (n: number) => Promise<{
                        getTextContent: () => Promise<{
                            items: { str?: string }[];
                        }>;
                    }>;
                }>;
            };
        }
    ).getDocument({ data: new Uint8Array(buf) }).promise;

    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        const text = tc.items
            .filter((it): it is { str: string } => typeof it.str === "string")
            .map((it) => it.str)
            .join(" ")
            .trim();
        if (text) pages.push(text);
    }
    return pages.join("\n\n");
}
