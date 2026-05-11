/**
 * Outlook .msg (binary OLE compound document) extraction.
 *
 * Maps @kenjiuno/msgreader output to the same `ParsedEml` shape used by
 * the .eml path, so the frontend EmlView component renders both formats
 * identically and the LLM read tool can reuse `emlToLLMText`. Attachments
 * are NOT recursively extracted — we just surface their filenames.
 */

import MsgReader from "@kenjiuno/msgreader";
import type { ParsedEml } from "./eml";
import { emlToLLMText, stripHtml } from "./eml";
import { renderAttachments, type AttachmentInput } from "./emailAttachments";
import { rtfCompressedToText } from "./rtf";

/**
 * msgreader's per-attachment FieldsData. We only narrow the fields we
 * touch — the real type has dozens more.
 */
interface MsgAttachment {
    fileName?: string;
    name?: string;
    innerMsgContent?: true;
    attachMimeTag?: string;
}

export async function extractMsg(buf: ArrayBuffer): Promise<ParsedEml> {
    const reader = new MsgReader(buf);
    const data = reader.getFileData();
    return buildParsedEml(data);
}

/**
 * .msg variant of extractEmlForLLM — see eml.ts for design notes. Reads
 * attachment binary content via MsgReader.getAttachment() and renders
 * each through the shared dispatcher.
 */
export async function extractMsgForLLM(
    buf: ArrayBuffer,
    depth = 0,
): Promise<string> {
    const reader = new MsgReader(buf);
    const data = reader.getFileData();
    const baseText = emlToLLMText(buildParsedEml(data));

    const attachmentBytes: AttachmentInput[] = [];
    const attachments = (data.attachments ?? []) as MsgAttachment[];
    for (let i = 0; i < attachments.length; i++) {
        const meta = attachments[i];
        if (!hasAttachmentName(meta)) continue;
        try {
            const att = reader.getAttachment(i);
            if (!att?.content) continue;
            attachmentBytes.push({
                // msgreader fills in `.msg` when this is an inner-msg
                // attachment (`fileName: attachData.name + ".msg"`),
                // otherwise hands back the real attachment fileName.
                filename: att.fileName ?? displayName(meta),
                bytes: Buffer.from(att.content),
            });
        } catch {
            // Inner-msg attachments occasionally fail to materialise;
            // skip silently. The summary line still lists the filename.
        }
    }

    if (attachmentBytes.length === 0) return baseText;
    const expanded = await renderAttachments(attachmentBytes, depth);
    if (!expanded) return baseText;
    return `${baseText}\n\n${expanded}`;
}

function buildParsedEml(data: ReturnType<MsgReader["getFileData"]>): ParsedEml {
    const recipients = data.recipients ?? [];
    const to = joinAddresses(recipients.filter((r) => r.recipType === "to"));
    const cc = joinAddresses(recipients.filter((r) => r.recipType === "cc"));

    return {
        subject: data.subject ?? null,
        from: formatSender(data.senderName, data.senderEmail),
        to,
        cc,
        date: parseDate(data.messageDeliveryTime),
        text: emailBodyText(data),
        attachments: ((data.attachments ?? []) as MsgAttachment[])
            .map((a) => ({
                filename: displayName(a),
                contentType: a.attachMimeTag ?? null,
            }))
            .filter(
                (a): a is { filename: string; contentType: string | null } =>
                    !!a.filename,
            ),
    };
}

/**
 * Body extraction fallback chain. Outlook saves the body in any of
 * three places depending on the compose mode and source:
 *   1. PidTagBody          — plain-text body
 *   2. PidTagBodyHtml      — HTML body (we strip tags)
 *   3. PidTagRtfCompressed — RFC-2557 encapsulated HTML or plain text
 *                            (decompress + de-encapsulate; common for
 *                            messages composed in Outlook HTML mode)
 */
function emailBodyText(data: ReturnType<MsgReader["getFileData"]>): string {
    if (data.body && data.body.trim()) return data.body;
    if (data.bodyHtml && data.bodyHtml.trim()) return stripHtml(data.bodyHtml);
    if (data.compressedRtf && data.compressedRtf.length > 0) {
        const rtfText = rtfCompressedToText(data.compressedRtf);
        if (rtfText.trim()) return rtfText;
    }
    return "";
}

/**
 * Inner-msg attachments don't have `fileName` set — they have `name`
 * with `innerMsgContent: true`, and msgreader.getAttachment() materialises
 * `name + ".msg"` as the filename. Normal attachments have `fileName`
 * directly.
 */
function hasAttachmentName(a: MsgAttachment): boolean {
    return !!a.fileName || a.innerMsgContent === true;
}

function displayName(a: MsgAttachment): string {
    if (a.fileName) return a.fileName;
    if (a.innerMsgContent === true) return `${a.name ?? "embedded"}.msg`;
    return "";
}

function formatSender(
    name: string | undefined,
    email: string | undefined,
): string | null {
    if (name && email && name !== email) return `${name} <${email}>`;
    return email ?? name ?? null;
}

function joinAddresses(
    recipients: { name?: string; email?: string }[],
): string | null {
    if (recipients.length === 0) return null;
    const parts = recipients
        .map((r) => formatSender(r.name, r.email))
        .filter((s): s is string => !!s);
    return parts.length > 0 ? parts.join(", ") : null;
}

function parseDate(raw: string | undefined): string | null {
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
}
