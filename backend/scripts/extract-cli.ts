/**
 * Local-only CLI for poking at the document extractors without spinning
 * up the full stack. Reads a file from disk, runs it through the same
 * code path the backend uses, prints the result to stdout.
 *
 * Usage:
 *   npx tsx scripts/extract-cli.ts <path>
 *   npx tsx scripts/extract-cli.ts <path> --llm
 *
 * The default output is the parsed JSON shape (what the /display
 * endpoint returns to the frontend). `--llm` switches to the
 * `read_document` text — i.e. headers + body + inlined attachment
 * text. File type is auto-detected from the suffix.
 *
 * Drop sample files into backend/scripts/samples/ — that directory is
 * gitignored so you can keep real emails locally without checking
 * them in.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { extractEml, extractEmlForLLM } from "../src/lib/extract/eml";
import { extractMsg, extractMsgForLLM } from "../src/lib/extract/msg";
import { extractTxt } from "../src/lib/extract/txt";
import { extractXlsx, xlsxToLLMText } from "../src/lib/extract/xlsx";

function suffixOf(p: string): string {
    const i = p.lastIndexOf(".");
    return i >= 0 ? p.slice(i + 1).toLowerCase() : "";
}

function bufToArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const llmMode = args.includes("--llm");
    const filePath = args.find((a) => !a.startsWith("--"));
    if (!filePath) {
        console.error(
            "Usage: npx tsx scripts/extract-cli.ts <path> [--llm]",
        );
        process.exit(2);
    }
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
        console.error(`File not found: ${abs}`);
        process.exit(2);
    }
    const buf = fs.readFileSync(abs);
    const ab = bufToArrayBuffer(buf);
    const suffix = suffixOf(abs);

    switch (suffix) {
        case "msg":
            if (llmMode) {
                console.log(await extractMsgForLLM(ab));
            } else {
                console.log(JSON.stringify(await extractMsg(ab), null, 2));
            }
            return;
        case "eml":
            if (llmMode) {
                console.log(await extractEmlForLLM(ab));
            } else {
                console.log(JSON.stringify(await extractEml(ab), null, 2));
            }
            return;
        case "txt":
            console.log(extractTxt(ab));
            return;
        case "xlsx": {
            const wb = await extractXlsx(ab);
            if (llmMode) {
                console.log(xlsxToLLMText(wb));
            } else {
                console.log(JSON.stringify(wb, null, 2));
            }
            return;
        }
        default:
            console.error(
                `Unsupported suffix .${suffix} — supported: msg, eml, txt, xlsx`,
            );
            process.exit(2);
    }
}

void main();
