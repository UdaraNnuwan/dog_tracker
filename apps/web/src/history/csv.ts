/** Minimal RFC 4180 CSV export for history tables. */

function cell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly object[]): string {
  const first = rows[0];
  if (!first) return "";
  const columns = Object.keys(first);
  const lines = rows.map((r) =>
    columns.map((c) => cell((r as Record<string, unknown>)[c])).join(","),
  );
  return [columns.join(","), ...lines].join("\n") + "\n";
}

export function downloadCsv(filename: string, rows: readonly object[]): void {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
