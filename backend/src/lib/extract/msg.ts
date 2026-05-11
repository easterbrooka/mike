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
import { emlToLLMText } from "./eml";
import { renderAttachments, type AttachmentInput } from "./emailAttachments";

export async function extractMsg(buf: ArrayBuffer): Promise<ParsedEml> {
    const reader = new MsgReader(buf);
    const data = reader.getFileData();

    const recipients = data.recipients ?? [];
    const to = joinAddresses(recipients.filter((r) => r.recipType === "to"));
    const cc = joinAddresses(recipients.filter((r) => r.recipType === "cc"));

    return {
        subject: data.subject ?? null,
        from: formatSender(data.senderName, data.senderEmail),
        to,
        cc,
        date: parseDate(data.messageDeliveryTime),
        text: data.body ?? "",
        attachments: (data.attachments ?? [])
            .filter((a) => !!a.fileName)
            .map((a) => ({
                filename: a.fileName as string,
                contentType: a.attachMimeTag ?? null,
            })),
    };
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

    const recipients = data.recipients ?? [];
    const to = joinAddresses(recipients.filter((r) => r.recipType === "to"));
    const cc = joinAddresses(recipients.filter((r) => r.recipType === "cc"));

    const eml: ParsedEml = {
        subject: data.subject ?? null,
        from: formatSender(data.senderName, data.senderEmail),
        to,
        cc,
        date: parseDate(data.messageDeliveryTime),
        text: data.body ?? "",
        attachments: (data.attachments ?? [])
            .filter((a) => !!a.fileName)
            .map((a) => ({
                filename: a.fileName as string,
                contentType: a.attachMimeTag ?? null,
            })),
    };
    const baseText = emlToLLMText(eml);

    const attachmentBytes: AttachmentInput[] = [];
    for (let i = 0; i < (data.attachments ?? []).length; i++) {
        const meta = (data.attachments ?? [])[i];
        if (!meta?.fileName) continue;
        try {
            const att = reader.getAttachment(i);
            if (!att?.content) continue;
            attachmentBytes.push({
                filename: meta.fileName,
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
