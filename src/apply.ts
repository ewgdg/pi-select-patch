import { AmbiguousHunkError, StaleHunkError, UnsupportedHunkError } from "./errors.js";
import { type HashFunction, hashLine } from "./hash.js";
import { parsePatch, type Hunk, type MatchPatchOp, type Patch } from "./patch-format.js";
import { renderHashLines, toHashLines, type HashLineEntry } from "./read-format.js";
import { parseText, serializeText } from "./text-lines.js";

export interface ApplyPatchOptions {
  hashFn?: HashFunction;
}

export type PatchReceiptLineKind = "context" | "insert";

export interface PatchReceiptLine {
  kind: PatchReceiptLineKind;
  hash: string;
}

export interface PatchHunkReceipt {
  hunkIndex: number;
  lines: PatchReceiptLine[];
}

export type PatchTranscriptLineKind = "context" | "delete" | "insert" | "contextRange";

export interface PatchTranscriptLine {
  kind: PatchTranscriptLineKind;
  content: string;
}

export interface PatchHunkTranscript {
  hunkIndex: number;
  matchStart: number | null;
  lines: PatchTranscriptLine[];
}

export interface PatchHunkAudit {
  hunkIndex: number;
  matchStart: number | null;
  matchPattern: string[];
  survivingContextHashes: string[];
  insertedHashes: string[];
  deletedHashes: string[];
}

export interface ApplyPatchResult {
  text: string;
  entries: HashLineEntry[];
  renderedHashLines: string;
  hunkReceipts: PatchHunkReceipt[];
  hunkAudits: PatchHunkAudit[];
  hunkTranscripts: PatchHunkTranscript[];
  renderedReceipt: string;
  receiptHashLineCount: number;
}

interface AppliedHunk {
  lines: string[];
  receipt: PatchHunkReceipt;
  transcript: PatchHunkTranscript;
  audit: PatchHunkAudit;
}

export function applyPatchToText(
  text: string,
  patchInput: string | Patch,
  options: ApplyPatchOptions = {}
): ApplyPatchResult {
  const hashFn = options.hashFn ?? hashLine;
  const patch = typeof patchInput === "string" ? parsePatch(patchInput, hashFn) : patchInput;
  const model = parseText(text);
  let currentLines = [...model.lines];
  const hunkReceipts: PatchHunkReceipt[] = [];
  const hunkAudits: PatchHunkAudit[] = [];
  const hunkTranscripts: PatchHunkTranscript[] = [];

  for (const [hunkOffset, hunk] of patch.hunks.entries()) {
    const applied = applyHunk(currentLines, hunk, hunkOffset + 1, hashFn);
    currentLines = applied.lines;
    hunkReceipts.push(applied.receipt);
    hunkAudits.push(applied.audit);
    hunkTranscripts.push(applied.transcript);
  }

  const finalText = serializeText({
    ...model,
    lines: currentLines,
    finalNewline: currentLines.length > 0 ? model.finalNewline : false
  });
  const entries = toHashLines(currentLines, hashFn);
  return {
    text: finalText,
    entries,
    renderedHashLines: renderHashLines(entries),
    hunkReceipts,
    hunkAudits,
    hunkTranscripts,
    renderedReceipt: renderPatchReceipt(hunkReceipts),
    receiptHashLineCount: hunkReceipts.reduce((count, receipt) => count + receipt.lines.length, 0)
  };
}

export function renderPatchReceipt(receipts: readonly PatchHunkReceipt[]): string {
  return receipts
    .flatMap((receipt) => ["@@ result", ...receipt.lines.map(renderPatchReceiptLine)])
    .join("\n");
}

function renderPatchReceiptLine(line: PatchReceiptLine): string {
  return `${line.kind === "insert" ? "+" : " "}${line.hash}`;
}

function applyHunk(lines: string[], hunk: Hunk, hunkIndex: number, hashFn: HashFunction): AppliedHunk {
  const matchPattern = buildMatchPattern(hunk);

  if (matchPattern.length === 0) {
    if (lines.length === 0 && hunk.ops.every((op) => op.kind === "insert")) {
      const insertedHashes = hunk.ops.map((op) => hashFn(op.content));
      return {
        lines: hunk.ops.map((op) => op.content),
        receipt: {
          hunkIndex,
          lines: insertedHashes.map((hash) => ({ kind: "insert", hash }))
        },
        transcript: {
          hunkIndex,
          matchStart: null,
          lines: hunk.ops.map((op) => ({ kind: "insert", content: op.content }))
        },
        audit: {
          hunkIndex,
          matchStart: null,
          matchPattern: [],
          survivingContextHashes: [],
          insertedHashes,
          deletedHashes: []
        }
      };
    }
    throw new UnsupportedHunkError(`Hunk ${hunkIndex} has no context/deletion locators; pure insertion requires an empty file.`);
  }

  validateSparseRanges(hunk, hunkIndex);

  const currentEntries = lines.map((content) => ({ content, hash: hashFn(content) }));
  const matchOps = hunk.ops.filter(isMatchOp);
  const matches = hunkHasSparseRange(hunk)
    ? findSparseMatches(currentEntries, hunk.ops, 2)
    : findContiguousMatches(currentEntries, matchOps).map((start) => contiguousMatchToSparseMatch(hunk.ops, start));
  if (matches.length === 0) {
    throw new StaleHunkError(`Hunk ${hunkIndex} match pattern ${matchPattern.join(" ")} was not found.`);
  }
  if (matches.length > 1) {
    throw new AmbiguousHunkError(
      `Hunk ${hunkIndex} match pattern ${matchPattern.join(" ")} matched ${matches.length} spans.`
    );
  }

  const match = matches[0];
  const replacement: string[] = [];
  const receiptLines: PatchReceiptLine[] = [];
  const survivingContextHashes: string[] = [];
  const insertedHashes: string[] = [];
  const deletedHashes: string[] = [];
  const transcriptLines: PatchTranscriptLine[] = [];

  for (const [opIndex, op] of hunk.ops.entries()) {
    if (op.kind === "insert") {
      replacement.push(op.content);
      transcriptLines.push({ kind: "insert", content: op.content });
      const insertedHash = hashFn(op.content);
      insertedHashes.push(insertedHash);
      receiptLines.push({ kind: "insert", hash: insertedHash });
      continue;
    }

    if (op.kind === "range") {
      const range = match.ranges.get(opIndex);
      if (!range) {
        throw new Error("Internal patch error: missing sparse range match.");
      }
      if (op.rangeKind === "context") {
        replacement.push(...lines.slice(range.start, range.end));
        transcriptLines.push({ kind: "contextRange", content: renderSkippedContextRange(range.end - range.start) });
      } else {
        for (let lineIndex = range.start; lineIndex < range.end; lineIndex += 1) {
          const targetContent = lines[lineIndex];
          const targetHash = hashFn(targetContent);
          transcriptLines.push({ kind: "delete", content: targetContent });
          deletedHashes.push(targetHash);
        }
      }
      continue;
    }

    const targetIndex = match.lineIndexes.get(opIndex);
    if (targetIndex === undefined) {
      throw new Error("Internal patch error: missing hash operation match.");
    }
    const targetContent = lines[targetIndex];
    const targetHash = hashFn(targetContent);
    if (op.kind === "context") {
      replacement.push(targetContent);
      transcriptLines.push({ kind: "context", content: targetContent });
      survivingContextHashes.push(targetHash);
      receiptLines.push({ kind: "context", hash: targetHash });
    } else {
      transcriptLines.push({ kind: "delete", content: targetContent });
      deletedHashes.push(targetHash);
    }
  }

  return {
    lines: [...lines.slice(0, match.start), ...replacement, ...lines.slice(match.end)],
    receipt: { hunkIndex, lines: receiptLines },
    transcript: { hunkIndex, matchStart: match.start, lines: transcriptLines },
    audit: {
      hunkIndex,
      matchStart: match.start,
      matchPattern,
      survivingContextHashes,
      insertedHashes,
      deletedHashes
    }
  };
}

interface SparseMatch {
  start: number;
  end: number;
  lineIndexes: Map<number, number>;
  ranges: Map<number, { start: number; end: number }>;
}

function isMatchOp(op: Hunk["ops"][number]): op is MatchPatchOp {
  return op.kind === "context" || op.kind === "delete";
}

interface CurrentLineEntry {
  hash: string;
  content: string;
}

function lineMatchesOp(line: CurrentLineEntry, op: MatchPatchOp): boolean {
  return hasMatchLocator(op) && (op.hash === undefined || op.hash === line.hash) && (op.content === undefined || op.content === line.content);
}

function hasMatchLocator(op: MatchPatchOp): boolean {
  return op.hash !== undefined || op.content !== undefined;
}

function hunkHasSparseRange(hunk: Hunk): boolean {
  return hunk.ops.some((op) => op.kind === "range");
}

function buildMatchPattern(hunk: Hunk): string[] {
  return hunk.ops.flatMap((op) => {
    if (op.kind === "insert") return [];
    if (op.kind === "range") return [`${op.rangeKind === "context" ? " " : "-"}...`];
    return [renderMatchLocator(op)];
  });
}

function renderMatchLocator(op: MatchPatchOp): string {
  if (!hasMatchLocator(op)) return "<missing locator>";
  const hash = op.hash ?? "";
  if (op.content === undefined) return hash;
  return `${hash}│${op.content}`;
}

function validateSparseRanges(hunk: Hunk, hunkIndex: number): void {
  for (const [opIndex, op] of hunk.ops.entries()) {
    if (op.kind !== "range") continue;
    const previousMatchOp = findNearestMatchOp(hunk.ops, opIndex, -1);
    const nextMatchOp = findNearestMatchOp(hunk.ops, opIndex, 1);
    if (previousMatchOp?.kind !== "context" || nextMatchOp?.kind !== "context") {
      throw new UnsupportedHunkError(`Hunk ${hunkIndex} '${op.rangeKind === "delete" ? "-..." : " ..."}' must be between context operations.`);
    }
  }
}

function findNearestMatchOp(ops: readonly Hunk["ops"][number][], start: number, step: -1 | 1): Hunk["ops"][number] | undefined {
  for (let index = start + step; index >= 0 && index < ops.length; index += step) {
    const op = ops[index];
    if (isMatchOp(op)) return op;
  }
  return undefined;
}

function contiguousMatchToSparseMatch(ops: readonly Hunk["ops"][number][], start: number): SparseMatch {
  const lineIndexes = new Map<number, number>();
  let consumed = 0;
  for (const [opIndex, op] of ops.entries()) {
    if (!isMatchOp(op)) continue;
    lineIndexes.set(opIndex, start + consumed);
    consumed += 1;
  }
  return { start, end: start + consumed, lineIndexes, ranges: new Map() };
}

function findSparseMatches(entries: CurrentLineEntry[], ops: readonly Hunk["ops"][number][], maxMatches: number): SparseMatch[] {
  const matches: SparseMatch[] = [];
  for (let start = 0; start <= entries.length && matches.length < maxMatches; start += 1) {
    collectSparseMatches({ entries, ops, opIndex: 0, position: start, start, lineIndexes: new Map(), ranges: new Map(), matches, maxMatches });
  }
  return matches;
}

function collectSparseMatches(state: {
  entries: CurrentLineEntry[];
  ops: readonly Hunk["ops"][number][];
  opIndex: number;
  position: number;
  start: number;
  lineIndexes: Map<number, number>;
  ranges: Map<number, { start: number; end: number }>;
  matches: SparseMatch[];
  maxMatches: number;
}): void {
  if (state.matches.length >= state.maxMatches) return;
  const opIndex = nextMatchOpIndex(state.ops, state.opIndex);
  if (opIndex === undefined) {
    state.matches.push({ start: state.start, end: state.position, lineIndexes: state.lineIndexes, ranges: state.ranges });
    return;
  }

  const op = state.ops[opIndex];
  if (isMatchOp(op)) {
    const entry = state.entries[state.position];
    if (!entry || !lineMatchesOp(entry, op)) return;
    const lineIndexes = new Map(state.lineIndexes);
    lineIndexes.set(opIndex, state.position);
    collectSparseMatches({ ...state, opIndex: opIndex + 1, position: state.position + 1, lineIndexes });
    return;
  }

  for (let end = state.position; end <= state.entries.length && state.matches.length < state.maxMatches; end += 1) {
    const ranges = new Map(state.ranges);
    ranges.set(opIndex, { start: state.position, end });
    collectSparseMatches({ ...state, opIndex: opIndex + 1, position: end, ranges });
  }
}

function nextMatchOpIndex(ops: readonly Hunk["ops"][number][], start: number): number | undefined {
  for (let index = start; index < ops.length; index += 1) {
    if (ops[index].kind !== "insert") return index;
  }
  return undefined;
}

function renderSkippedContextRange(lineCount: number): string {
  return lineCount === 0 ? "..." : `... ${lineCount} skipped context line${lineCount === 1 ? "" : "s"}`;
}

function findContiguousMatches(entries: CurrentLineEntry[], sequence: readonly MatchPatchOp[]): number[] {
  const matches: number[] = [];
  for (let index = 0; index <= entries.length - sequence.length; index += 1) {
    if (sequence.every((op, offset) => lineMatchesOp(entries[index + offset], op))) {
      matches.push(index);
    }
  }
  return matches;
}
