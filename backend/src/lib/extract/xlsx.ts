/**
 * Spreadsheet (.xlsx) extraction.
 *
 * Uses ExcelJS to load the workbook, then materialises each sheet as a 2D
 * array of normalised cell values. Sheets are capped at MAX_ROWS × MAX_COLS
 * so a million-row inventory dump doesn't blow context or render the UI
 * unusable — overflow is signposted in the LLM text and the UI rendering.
 */

import ExcelJS from "exceljs";

const MAX_ROWS = 1000;
const MAX_COLS = 50;

export type CellValue = string | number | boolean | null;

export interface ParsedXlsx {
    sheets: ParsedSheet[];
}

export interface ParsedSheet {
    name: string;
    rows: CellValue[][];
    /** Set when the source sheet exceeded MAX_ROWS or MAX_COLS. */
    truncated: { rows: boolean; cols: boolean; sourceRows: number; sourceCols: number } | null;
}

export async function extractXlsx(buf: ArrayBuffer): Promise<ParsedXlsx> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf);

    const sheets: ParsedSheet[] = [];
    workbook.eachSheet((worksheet) => {
        sheets.push(parseSheet(worksheet));
    });
    return { sheets };
}

function parseSheet(sheet: ExcelJS.Worksheet): ParsedSheet {
    const sourceRows = sheet.rowCount;
    const sourceCols = sheet.columnCount;
    const rowsToTake = Math.min(sourceRows, MAX_ROWS);
    const colsToTake = Math.min(sourceCols, MAX_COLS);

    const rows: CellValue[][] = [];
    for (let r = 1; r <= rowsToTake; r++) {
        const row = sheet.getRow(r);
        const out: CellValue[] = [];
        for (let c = 1; c <= colsToTake; c++) {
            out.push(normaliseCell(row.getCell(c).value));
        }
        rows.push(out);
    }

    const truncated =
        sourceRows > MAX_ROWS || sourceCols > MAX_COLS
            ? {
                  rows: sourceRows > MAX_ROWS,
                  cols: sourceCols > MAX_COLS,
                  sourceRows,
                  sourceCols,
              }
            : null;

    return { name: sheet.name, rows, truncated };
}

/**
 * Coerces an ExcelJS cell value into a plain primitive. Formula cells use
 * the cached `.result`, dates become ISO strings, rich text becomes its
 * concatenated runs. Anything else exotic falls back to String().
 */
function normaliseCell(value: ExcelJS.CellValue): CellValue {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value;
    if (value instanceof Date) return value.toISOString();

    if (typeof value === "object") {
        const v = value as unknown as Record<string, unknown>;
        if ("error" in v) return String(v.error);
        if ("formula" in v) return normaliseCell(v.result as ExcelJS.CellValue);
        if ("richText" in v && Array.isArray(v.richText)) {
            return (v.richText as { text?: string }[])
                .map((r) => r.text ?? "")
                .join("");
        }
        if ("text" in v && typeof v.text === "string") return v.text;
        if ("hyperlink" in v && typeof v.hyperlink === "string") {
            return (v.text as string | undefined) ?? (v.hyperlink as string);
        }
    }
    return String(value);
}

/**
 * Renders the parsed workbook as markdown, one section per sheet. Empty
 * sheets are noted but skipped. Capped at MAX_ROWS × MAX_COLS per sheet
 * already by extractXlsx — this function just formats.
 */
export function xlsxToLLMText(workbook: ParsedXlsx): string {
    const parts: string[] = [];
    for (const sheet of workbook.sheets) {
        parts.push(`## ${sheet.name}`);
        if (sheet.rows.length === 0) {
            parts.push("_(empty sheet)_\n");
            continue;
        }
        const widths = sheet.rows[0].length;
        const header = sheet.rows[0].map(cellToMarkdown);
        const sep = Array(widths).fill("---");
        const body = sheet.rows
            .slice(1)
            .map((r) => `| ${r.map(cellToMarkdown).join(" | ")} |`);
        parts.push(
            [
                `| ${header.join(" | ")} |`,
                `| ${sep.join(" | ")} |`,
                ...body,
            ].join("\n"),
        );
        if (sheet.truncated) {
            const { rows, cols, sourceRows, sourceCols } = sheet.truncated;
            const notes: string[] = [];
            if (rows) notes.push(`rows truncated from ${sourceRows} to ${MAX_ROWS}`);
            if (cols) notes.push(`columns truncated from ${sourceCols} to ${MAX_COLS}`);
            parts.push(`\n_[${notes.join("; ")}]_`);
        }
        parts.push("");
    }
    return parts.join("\n").trim();
}

function cellToMarkdown(v: CellValue): string {
    if (v === null) return "";
    const s = String(v);
    return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
