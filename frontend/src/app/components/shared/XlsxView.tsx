"use client";

import { useState } from "react";
import type {
    ParsedXlsx,
    ParsedXlsxSheet,
    XlsxCellValue,
} from "./extractedDocTypes";

interface Props {
    parsed: ParsedXlsx;
    rounded?: boolean;
    bordered?: boolean;
}

export function XlsxView({ parsed, rounded = true, bordered = true }: Props) {
    const [activeIndex, setActiveIndex] = useState(0);
    const radius = rounded ? "rounded-md" : "";
    const border = bordered ? "border border-gray-200" : "";

    if (parsed.sheets.length === 0) {
        return (
            <div
                className={`flex h-full w-full items-center justify-center bg-white ${radius} ${border}`}
            >
                <p className="text-sm text-gray-500">No sheets in workbook.</p>
            </div>
        );
    }

    const sheet = parsed.sheets[Math.min(activeIndex, parsed.sheets.length - 1)];

    return (
        <div
            className={`flex h-full w-full flex-col overflow-hidden bg-white ${radius} ${border}`}
        >
            {parsed.sheets.length > 1 && (
                <div className="flex shrink-0 overflow-x-auto border-b border-gray-200 bg-gray-50">
                    {parsed.sheets.map((s, i) => (
                        <button
                            key={i}
                            type="button"
                            onClick={() => setActiveIndex(i)}
                            className={`whitespace-nowrap border-r border-gray-200 px-3 py-1.5 text-xs ${
                                i === activeIndex
                                    ? "bg-white font-medium text-gray-900"
                                    : "text-gray-600 hover:bg-white"
                            }`}
                        >
                            {s.name}
                        </button>
                    ))}
                </div>
            )}
            <SheetTable sheet={sheet} />
        </div>
    );
}

function SheetTable({ sheet }: { sheet: ParsedXlsxSheet }) {
    if (sheet.rows.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center">
                <p className="text-sm text-gray-500">Empty sheet.</p>
            </div>
        );
    }
    const [header, ...body] = sheet.rows;
    return (
        <div className="flex-1 overflow-auto">
            <table className="min-w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-gray-100">
                    <tr>
                        {header.map((cell, i) => (
                            <th
                                key={i}
                                className="border border-gray-200 px-2 py-1 text-left font-semibold text-gray-700"
                            >
                                {renderCell(cell)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {body.map((row, r) => (
                        <tr key={r} className="odd:bg-white even:bg-gray-50">
                            {row.map((cell, c) => (
                                <td
                                    key={c}
                                    className="border border-gray-200 px-2 py-1 text-gray-800"
                                >
                                    {renderCell(cell)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            {sheet.truncated && (
                <div className="border-t border-gray-200 bg-yellow-50 px-3 py-1.5 text-xs text-yellow-900">
                    {sheet.truncated.rows &&
                        `Showing ${sheet.rows.length.toLocaleString()} of ${sheet.truncated.sourceRows.toLocaleString()} rows. `}
                    {sheet.truncated.cols &&
                        `Showing first ${header.length} of ${sheet.truncated.sourceCols} columns.`}
                </div>
            )}
        </div>
    );
}

function renderCell(value: XlsxCellValue): string {
    if (value === null || value === undefined) return "";
    return String(value);
}
