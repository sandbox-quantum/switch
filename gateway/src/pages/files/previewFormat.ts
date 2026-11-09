import type { CloudFileEntry } from "./cloudFiles";

/** The most CSV rows the preview shows, after the header. */
export const CSV_MAX_ROWS = 1000;
/** The most CSV columns the preview shows. */
export const CSV_MAX_COLUMNS = 50;

export type CsvTable = {
  /** The first row, as the column headings. */
  header: string[];
  /** Up to `CSV_MAX_ROWS` rows after the header, each cut to `CSV_MAX_COLUMNS` cells. */
  rows: string[][];
  /** How many rows follow the header in the whole file. */
  totalRows: number;
  /** Whether any row had more columns than are shown. */
  moreColumns: boolean;
};

/**
 * A CSV (or TSV) file as a table of plain strings: quoted fields, doubled
 * quotes and line breaks inside quotes are read as the format means them.
 * Nothing in a cell is ever treated as anything but text.
 */
export function parseCsv(
  text: string,
  delimiter: ',' | '\t' = ',',
  maxRows: number = CSV_MAX_ROWS,
  maxColumns: number = CSV_MAX_COLUMNS
): CsvTable {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const all: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let index = 0;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    all.push(row);
    row = [];
  };
  while (index < source.length) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === delimiter) endCell();
    else if (char === '\n') endRow();
    else if (char === '\r') {
      if (source[index + 1] === '\n') index += 1;
      endRow();
    } else cell += char;
    index += 1;
  }
  if (cell !== '' || row.length > 0 || quoted) endRow();
  const moreColumns = all.some((cells) => cells.length > maxColumns);
  const cut = (cells: string[]) => cells.slice(0, maxColumns);
  const [header = [], ...body] = all;
  return {
    header: cut(header),
    rows: body.slice(0, maxRows).map(cut),
    totalRows: body.length,
    moreColumns,
  };
}

/** JSON laid out two spaces deep, or null when it isn't valid JSON. Parsed, never run. */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** The files either side of `name` in a folder's shown order; folders are skipped. */
export function neighbourFiles(
  entries: readonly CloudFileEntry[],
  name: string
): { previous: CloudFileEntry | null; next: CloudFileEntry | null } {
  const files = entries.filter((entry) => entry.kind === 'file');
  const at = files.findIndex((entry) => entry.name === name);
  if (at < 0) return { previous: null, next: null };
  return { previous: files[at - 1] ?? null, next: files[at + 1] ?? null };
}
