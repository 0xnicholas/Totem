import type { CellValue } from '../actions.js';

/**
 * Spreadsheet range notation shared by the Seam A fake and Seam B mock
 * (T9): parses `SheetName!A1:C3` (and bare `A1:C3`, which means the
 * first sheet) into 1-based column/row bounds. Columns are letters
 * (A, B, ..., AA, ...); the connector passes ranges through unchanged,
 * so this only needs to satisfy the test doubles.
 */
export interface RangeRef {
  /** Sheet name before '!', or undefined for a bare range. */
  sheet: string | undefined;
  colStart: number;
  rowStart: number;
  colEnd: number;
  rowEnd: number;
}

const RANGE_PATTERN = /^(?:([^!]+)!)?([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/;

/** Parses a range string into bounds; undefined when malformed. */
export function parseRange(range: string): RangeRef | undefined {
  const match = RANGE_PATTERN.exec(range);
  if (!match) return undefined;
  const colStart = columnIndex(match[2]!);
  const rowStart = Number(match[3]);
  return {
    sheet: match[1],
    colStart,
    rowStart,
    // A bare cell reference ("Data!C3") means that single cell.
    colEnd: match[4] !== undefined ? columnIndex(match[4]) : colStart,
    rowEnd: match[5] !== undefined ? Number(match[5]) : rowStart,
  };
}

/** A=1, B=2, ..., Z=26, AA=27, ... */
function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index;
}

/** Slices a value matrix to a range; out-of-bounds cells read as null. */
export function sliceValues(values: CellValue[][], ref: RangeRef): CellValue[][] {
  const rows: CellValue[][] = [];
  for (let row = ref.rowStart; row <= ref.rowEnd; row++) {
    const cells: CellValue[] = [];
    for (let col = ref.colStart; col <= ref.colEnd; col++) {
      cells.push(values[row - 1]?.[col - 1] ?? null);
    }
    rows.push(cells);
  }
  return rows;
}

export interface WriteResult {
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

/**
 * Writes a value matrix into a range, growing the source matrix with nulls
 * as needed. Returns the affected shape. Mutates `values` in place.
 */
export function writeValues(
  values: CellValue[][],
  ref: RangeRef,
  incoming: CellValue[][],
): WriteResult {
  const height = ref.rowEnd - ref.rowStart + 1;
  const width = ref.colEnd - ref.colStart + 1;
  while (values.length < ref.rowEnd) values.push([]);
  for (const row of values) {
    while (row.length < ref.colEnd) row.push(null);
  }
  for (let i = 0; i < height; i++) {
    const incomingRow = incoming[i] ?? [];
    for (let j = 0; j < width; j++) {
      values[ref.rowStart - 1 + i]![ref.colStart - 1 + j] =
        j < incomingRow.length ? (incomingRow[j] ?? null) : null;
    }
  }
  return { updatedRows: height, updatedColumns: width, updatedCells: height * width };
}
