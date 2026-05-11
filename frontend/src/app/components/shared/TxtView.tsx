"use client";

interface Props {
    text: string;
    rounded?: boolean;
    bordered?: boolean;
}

export function TxtView({ text, rounded = true, bordered = true }: Props) {
    const radius = rounded ? "rounded-md" : "";
    const border = bordered ? "border border-gray-200" : "";
    return (
        <div
            className={`flex h-full w-full overflow-auto bg-white ${radius} ${border}`}
        >
            <pre className="w-full whitespace-pre-wrap break-words p-4 font-mono text-sm leading-relaxed text-gray-800">
                {text}
            </pre>
        </div>
    );
}
