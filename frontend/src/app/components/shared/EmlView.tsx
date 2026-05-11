"use client";

import { Paperclip } from "lucide-react";
import type { ParsedEml } from "./extractedDocTypes";

interface Props {
    parsed: ParsedEml;
    rounded?: boolean;
    bordered?: boolean;
}

export function EmlView({ parsed, rounded = true, bordered = true }: Props) {
    const radius = rounded ? "rounded-md" : "";
    const border = bordered ? "border border-gray-200" : "";
    const date = parsed.date ? formatDate(parsed.date) : null;
    return (
        <div
            className={`flex h-full w-full flex-col overflow-auto bg-white ${radius} ${border}`}
        >
            <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
                {parsed.subject && (
                    <div className="mb-2 text-base font-semibold text-gray-900">
                        {parsed.subject}
                    </div>
                )}
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-gray-700">
                    {parsed.from && (
                        <>
                            <dt className="font-medium text-gray-500">From</dt>
                            <dd className="truncate">{parsed.from}</dd>
                        </>
                    )}
                    {parsed.to && (
                        <>
                            <dt className="font-medium text-gray-500">To</dt>
                            <dd className="truncate">{parsed.to}</dd>
                        </>
                    )}
                    {parsed.cc && (
                        <>
                            <dt className="font-medium text-gray-500">Cc</dt>
                            <dd className="truncate">{parsed.cc}</dd>
                        </>
                    )}
                    {date && (
                        <>
                            <dt className="font-medium text-gray-500">Date</dt>
                            <dd>{date}</dd>
                        </>
                    )}
                </dl>
                {parsed.attachments.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                        <Paperclip className="h-3.5 w-3.5 text-gray-500" />
                        {parsed.attachments.map((a, i) => (
                            <span
                                key={i}
                                className="rounded-md border border-gray-200 bg-white px-2 py-0.5"
                            >
                                {a.filename}
                            </span>
                        ))}
                    </div>
                )}
            </div>
            <pre className="flex-1 whitespace-pre-wrap break-words p-4 font-sans text-sm leading-relaxed text-gray-800">
                {parsed.text || "(no message body)"}
            </pre>
        </div>
    );
}

function formatDate(iso: string): string {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleString();
    } catch {
        return iso;
    }
}
