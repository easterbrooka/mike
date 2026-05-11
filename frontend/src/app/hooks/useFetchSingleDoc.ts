"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { apiBase } from "@/app/lib/apiBase";
import type {
    ParsedEml,
    ParsedXlsx,
} from "@/app/components/shared/extractedDocTypes";

/**
 * /display returns one of:
 *   - PDF bytes                            (active version has a PDF rendition)
 *   - DOCX bytes                           (active version has no PDF rendition)
 *   - plain text                           (.txt uploads)
 *   - application/vnd.mike.eml+json        (.eml, pre-parsed)
 *   - application/vnd.mike.xlsx+json       (.xlsx, pre-parsed)
 *
 * The hook reads the response Content-Type and surfaces the parsed shape
 * for the new types so callers don't have to know how to parse .eml /.xlsx
 * client-side.
 */
export type DocResult =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "docx" }
    | { type: "txt"; text: string }
    | { type: "eml"; parsed: ParsedEml }
    | { type: "xlsx"; parsed: ParsedXlsx }
    | null;

export function useFetchSingleDoc(
    documentId: string | null | undefined,
    versionId?: string | null,
) {
    const [result, setResult] = useState<DocResult>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const prevKeyRef = useRef<string | null>(null);

    useEffect(() => {
        if (!documentId) return;
        const requestKey = `${documentId}:${versionId ?? "current"}`;
        if (requestKey === prevKeyRef.current) return;
        prevKeyRef.current = requestKey;

        setLoading(true);
        setError(null);
        setResult(null);

        let cancelled = false;

        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const token = session?.access_token;
                if (cancelled) return;

                const qs = versionId
                    ? `?version_id=${encodeURIComponent(versionId)}`
                    : "";
                const response = await fetch(
                    `${apiBase()}/single-documents/${documentId}/display${qs}`,
                    {
                        headers: token
                            ? { Authorization: `Bearer ${token}` }
                            : {},
                    },
                );
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                if (cancelled) return;

                const contentType =
                    response.headers.get("content-type") ?? "";
                if (contentType.includes("application/pdf")) {
                    const buffer = await response.arrayBuffer();
                    if (!cancelled) setResult({ type: "pdf", buffer });
                } else if (contentType.includes("application/vnd.mike.eml+json")) {
                    const parsed = (await response.json()) as ParsedEml;
                    if (!cancelled) setResult({ type: "eml", parsed });
                } else if (contentType.includes("application/vnd.mike.xlsx+json")) {
                    const parsed = (await response.json()) as ParsedXlsx;
                    if (!cancelled) setResult({ type: "xlsx", parsed });
                } else if (contentType.includes("text/plain")) {
                    const text = await response.text();
                    if (!cancelled) setResult({ type: "txt", text });
                } else {
                    // Drain the body so the connection is reusable, but the
                    // bytes are useless to the PDF viewer — the caller will
                    // fall back to DocxView, which fetches `/docx` itself.
                    await response.arrayBuffer().catch(() => {});
                    if (!cancelled) setResult({ type: "docx" });
                }
            } catch {
                if (!cancelled) setError("Failed to load document.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            prevKeyRef.current = null;
        };
    }, [documentId, versionId]);

    return { result, loading, error };
}
