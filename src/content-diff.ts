import { parseText } from "./text-lines.js";

export type FileDiffKind = "add" | "update" | "delete";

export interface FileContentDiffInput {
  kind: FileDiffKind;
  path: string;
  oldText?: string;
  newText?: string;
}

interface DiffRow {
  prefix: " " | "-" | "+";
  content: string;
}

export function renderUnifiedContentDiffs(inputs: readonly FileContentDiffInput[]): string {
  return inputs.map(renderUnifiedContentDiff).join("\n");
}

export function renderUnifiedContentDiff(input: FileContentDiffInput): string {
  const oldLines = input.oldText === undefined ? [] : parseText(input.oldText).lines;
  const newLines = input.newText === undefined ? [] : parseText(input.newText).lines;
  const oldPath = input.kind === "add" ? "/dev/null" : `a/${input.path}`;
  const newPath = input.kind === "delete" ? "/dev/null" : `b/${input.path}`;
  const rows = input.kind === "add"
    ? newLines.map<DiffRow>((content) => ({ prefix: "+", content }))
    : input.kind === "delete"
      ? oldLines.map<DiffRow>((content) => ({ prefix: "-", content }))
      : diffRows(oldLines, newLines);

  return [
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    `@@ -${hunkRange(oldLines.length)} +${hunkRange(newLines.length)} @@`,
    ...rows.map((row) => `${row.prefix}${row.content}`)
  ].join("\n");
}

function hunkRange(lineCount: number): string {
  return lineCount === 0 ? "0,0" : `1,${lineCount}`;
}

function diffRows(oldLines: readonly string[], newLines: readonly string[]): DiffRow[] {
  const table = buildLcsTable(oldLines, newLines);
  const rows: DiffRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({ prefix: " ", content: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      rows.push({ prefix: "-", content: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      rows.push({ prefix: "+", content: newLines[newIndex] });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    rows.push({ prefix: "-", content: oldLines[oldIndex] });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    rows.push({ prefix: "+", content: newLines[newIndex] });
    newIndex += 1;
  }

  return rows;
}

function buildLcsTable(oldLines: readonly string[], newLines: readonly string[]): number[][] {
  const table = Array.from({ length: oldLines.length + 1 }, () => Array.from({ length: newLines.length + 1 }, () => 0));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  return table;
}
