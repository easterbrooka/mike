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
