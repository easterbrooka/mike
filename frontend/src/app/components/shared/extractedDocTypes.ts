/**
 * Shapes returned by GET /single-documents/:id/display for the new doc
 * types (.eml, .xlsx). The backend parses these server-side so neither
 * mailparser nor exceljs ever ships in the browser bundle. These types
 * mirror the backend shapes in backend/src/lib/extract/{eml,xlsx}.ts.
 */

export interface ParsedEml {
    subject: string | null;
    from: string | null;
    to: string | null;
    cc: string | null;
    date: string | null;
    text: string;
    attachments: { filename: string; contentType: string | null }[];
}

export type XlsxCellValue = string | number | boolean | null;

export interface ParsedXlsxSheet {
    name: string;
    rows: XlsxCellValue[][];
    truncated: {
        rows: boolean;
        cols: boolean;
        sourceRows: number;
        sourceCols: number;
    } | null;
}

export interface ParsedXlsx {
    sheets: ParsedXlsxSheet[];
}
