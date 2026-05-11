import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { extractXlsx, xlsxToLLMText } from "../xlsx";

async function buildXlsx(
    populate: (workbook: ExcelJS.Workbook) => void,
): Promise<ArrayBuffer> {
    const wb = new ExcelJS.Workbook();
    populate(wb);
    const buf = (await wb.xlsx.writeBuffer()) as Buffer;
    return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
}

describe("extractXlsx", () => {
    it("returns one sheet with rows of normalised cell values", async () => {
        const ab = await buildXlsx((wb) => {
            const ws = wb.addWorksheet("People");
            ws.addRow(["name", "age", "active"]);
            ws.addRow(["Alice", 30, true]);
            ws.addRow(["Bob", 25, false]);
        });
        const parsed = await extractXlsx(ab);
        expect(parsed.sheets).toHaveLength(1);
        const sheet = parsed.sheets[0];
        expect(sheet.name).toBe("People");
        expect(sheet.rows).toEqual([
            ["name", "age", "active"],
            ["Alice", 30, true],
            ["Bob", 25, false],
        ]);
        expect(sheet.truncated).toBeNull();
    });

    it("evaluates formula cells via their cached result", async () => {
        const ab = await buildXlsx((wb) => {
            const ws = wb.addWorksheet("Calc");
            ws.addRow([2, 3]);
            const row = ws.addRow([]);
            row.getCell(1).value = { formula: "A1+B1", result: 5 };
        });
        const parsed = await extractXlsx(ab);
        expect(parsed.sheets[0].rows[1][0]).toBe(5);
    });

    it("returns every sheet in the workbook", async () => {
        const ab = await buildXlsx((wb) => {
            wb.addWorksheet("First").addRow(["a"]);
            wb.addWorksheet("Second").addRow(["b"]);
            wb.addWorksheet("Third").addRow(["c"]);
        });
        const parsed = await extractXlsx(ab);
        expect(parsed.sheets.map((s) => s.name)).toEqual([
            "First",
            "Second",
            "Third",
        ]);
    });

    it("truncates oversized sheets and reports the original dimensions", async () => {
        const ab = await buildXlsx((wb) => {
            const ws = wb.addWorksheet("Huge");
            for (let i = 0; i < 1200; i++) {
                ws.addRow([i, `row-${i}`]);
            }
        });
        const parsed = await extractXlsx(ab);
        const sheet = parsed.sheets[0];
        expect(sheet.rows.length).toBe(1000);
        expect(sheet.truncated).toEqual({
            rows: true,
            cols: false,
            sourceRows: 1200,
            sourceCols: 2,
        });
    });

    it("converts Date cells to ISO strings", async () => {
        const ab = await buildXlsx((wb) => {
            const ws = wb.addWorksheet("Dates");
            ws.addRow([new Date("2026-05-11T00:00:00Z")]);
        });
        const parsed = await extractXlsx(ab);
        expect(parsed.sheets[0].rows[0][0]).toBe("2026-05-11T00:00:00.000Z");
    });
});

describe("xlsxToLLMText", () => {
    it("renders each sheet as a markdown table with a header row", async () => {
        const ab = await buildXlsx((wb) => {
            const ws = wb.addWorksheet("S1");
            ws.addRow(["a", "b"]);
            ws.addRow([1, 2]);
        });
        const parsed = await extractXlsx(ab);
        const md = xlsxToLLMText(parsed);
        expect(md).toContain("## S1");
        expect(md).toContain("| a | b |");
        expect(md).toContain("| --- | --- |");
        expect(md).toContain("| 1 | 2 |");
    });

    it("escapes pipe characters in cell values", async () => {
        const ab = await buildXlsx((wb) => {
            const ws = wb.addWorksheet("S");
            ws.addRow(["a|b"]);
        });
        const parsed = await extractXlsx(ab);
        const md = xlsxToLLMText(parsed);
        expect(md).toContain("a\\|b");
    });

    it("notes truncation in the rendered output", async () => {
        const ab = await buildXlsx((wb) => {
            const ws = wb.addWorksheet("Huge");
            for (let i = 0; i < 1100; i++) ws.addRow([i]);
        });
        const parsed = await extractXlsx(ab);
        const md = xlsxToLLMText(parsed);
        expect(md).toMatch(/rows truncated from 1100 to 1000/);
    });
});
