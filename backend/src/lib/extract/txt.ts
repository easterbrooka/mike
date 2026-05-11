/**
 * Plain-text extraction for .txt uploads.
 *
 * UTF-8 decode with BOM stripping. We don't try to handle other encodings —
 * if a user uploads a Windows-1252 file with non-ASCII bytes, they'll see
 * U+FFFD replacements. That's acceptable for an internal tool.
 */

const MAX_LLM_CHARS = 200_000;

export function extractTxt(buf: ArrayBuffer): string {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let text = decoder.decode(buf);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
}

/**
 * Returns a string suitable for handing to the LLM. Caps at MAX_LLM_CHARS
 * so an accidental upload of a 10 MB log file doesn't blow the context
 * window — truncation is signposted so the model knows it's incomplete.
 */
export function txtToLLMText(text: string): string {
    if (text.length <= MAX_LLM_CHARS) return text;
    return (
        text.slice(0, MAX_LLM_CHARS) +
        `\n\n[…truncated at ${MAX_LLM_CHARS.toLocaleString()} characters]`
    );
}
