/**
 * Email (.eml / RFC 822) extraction.
 *
 * Uses mailparser to parse the message. We return both a structured object
 * for the UI preview and a flat text rendering for the LLM. Attachments are
 * NOT recursively extracted — we just list their filenames so the LLM and
 * the user can see what was attached.
 */

import { simpleParser } from "mailparser";
import { renderAttachments, type AttachmentInput } from "./emailAttachments";

const MAX_LLM_CHARS = 200_000;

export interface ParsedEml {
    subject: string | null;
    from: string | null;
    to: string | null;
    cc: string | null;
    date: string | null;
    text: string;
    attachments: { filename: string; contentType: string | null }[];
}

export async function extractEml(buf: ArrayBuffer): Promise<ParsedEml> {
    const parsed = await simpleParser(Buffer.from(buf));

    const text =
        (parsed.text && parsed.text.trim()) ||
        (parsed.html ? stripHtml(parsed.html) : "") ||
        "";

    return {
        subject: parsed.subject ?? null,
        from: parsed.from?.text ?? null,
        to: addressText(parsed.to),
        cc: addressText(parsed.cc),
        date: parsed.date ? parsed.date.toISOString() : null,
        text,
        attachments: (parsed.attachments ?? [])
            .filter((a) => !!a.filename)
            .map((a) => ({
                filename: a.filename as string,
                contentType: a.contentType ?? null,
            })),
    };
}

/**
 * Renders the parsed email as a single flat string for the LLM. Headers
 * become a YAML-ish preamble, then the body, then a trailing attachments
 * list if any. Capped at MAX_LLM_CHARS.
 */
export function emlToLLMText(eml: ParsedEml): string {
    const lines: string[] = [];
    if (eml.subject) lines.push(`Subject: ${eml.subject}`);
    if (eml.from) lines.push(`From: ${eml.from}`);
    if (eml.to) lines.push(`To: ${eml.to}`);
    if (eml.cc) lines.push(`Cc: ${eml.cc}`);
    if (eml.date) lines.push(`Date: ${eml.date}`);

    const header = lines.join("\n");
    let body = `${header}\n\n${eml.text}`;

    if (eml.attachments.length > 0) {
        const names = eml.attachments.map((a) => a.filename).join(", ");
        body += `\n\n[Attachments: ${names}]`;
    }

    if (body.length > MAX_LLM_CHARS) {
        body =
            body.slice(0, MAX_LLM_CHARS) +
            `\n\n[…truncated at ${MAX_LLM_CHARS.toLocaleString()} characters]`;
    }
    return body;
}

/**
 * Variant of the .eml pipeline used by chatTools.read_document. Renders
 * the email AND the text of any extractable attachments (PDF/DOCX/TXT/
 * XLSX/recursive EML/MSG). The /display endpoint keeps using extractEml
 * + emlToLLMText, which only surfaces attachment filenames — UI shape is
 * unchanged.
 */
export async function extractEmlForLLM(
    buf: ArrayBuffer,
    depth = 0,
): Promise<string> {
    const parsed = await simpleParser(Buffer.from(buf));
    const eml: ParsedEml = {
        subject: parsed.subject ?? null,
        from: parsed.from?.text ?? null,
        to: addressText(parsed.to),
        cc: addressText(parsed.cc),
        date: parsed.date ? parsed.date.toISOString() : null,
        text:
            (parsed.text && parsed.text.trim()) ||
            (parsed.html ? stripHtml(parsed.html) : "") ||
            "",
        attachments: (parsed.attachments ?? [])
            .filter((a) => !!a.filename)
            .map((a) => ({
                filename: a.filename as string,
                contentType: a.contentType ?? null,
            })),
    };
    const baseText = emlToLLMText(eml);

    // mailparser flags inline images (signature logos, cid:-referenced
    // HTML embeds) as `related: true`. Skip them — the user does not
    // think of them as documents.
    const attachmentBytes: AttachmentInput[] = (parsed.attachments ?? [])
        .filter((a) => !!a.filename && !a.related && Buffer.isBuffer(a.content))
        .map((a) => ({
            filename: a.filename as string,
            bytes: a.content as Buffer,
        }));

    if (attachmentBytes.length === 0) return baseText;
    const expanded = await renderAttachments(attachmentBytes, depth);
    if (!expanded) return baseText;
    return `${baseText}\n\n${expanded}`;
}

type AddressGroup = { text?: string };

function addressText(
    field: AddressGroup | AddressGroup[] | undefined,
): string | null {
    if (!field) return null;
    if (Array.isArray(field)) {
        const joined = field
            .map((f) => f.text ?? "")
            .filter(Boolean)
            .join(", ");
        return joined || null;
    }
    return field.text ?? null;
}

function stripHtml(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
