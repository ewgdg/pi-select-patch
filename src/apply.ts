import { AmbiguousHunkError, InvalidPatchError, StaleHunkError, UnsupportedHunkError } from "./errors.js";
import { type HashFunction, hashLine } from "./hash.js";
import { normalizeCombinedTextSelector, parsePatch, type Hunk, type MatchPatchOp, type Patch } from "./patch-format.js";
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

export type PatchMatcherKind = "exact" | "prefix" | "contains" | "suffix" | "hash" | "combined" | "range" | "unifiedDiff";

export interface PatchHunkAudit {
  hunkIndex: number;
  matchStart: number | null;
  matchPattern: string[];
  matcherKinds: PatchMatcherKind[];
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
  return `${line.kind === "insert" ? "+" : "="}${line.hash}`;
}

function applyHunk(lines: string[], hunk: Hunk, hunkIndex: number, hashFn: HashFunction): AppliedHunk {
  validateHunkAnchorHint(hunk, hunkIndex);
  validateNoConflictingLocators(hunk, hunkIndex);
  const matchPattern = buildMatchPattern(hunk);

  if (matchPattern.length === 0) {
    if (hunk.anchorHint) {
      throw new UnsupportedHunkError(`Hunk ${hunkIndex} anchor hint requires at least one context/deletion locator.`);
    }
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
          matcherKinds: [],
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
  const searchStart = getAnchorSearchStart(hunk);
  const searchEnd = getAnchorSearchEnd(hunk);
  const matches = hunkHasSparseRange(hunk)
    ? findSparseMatches(currentEntries, hunk.ops, 2, searchStart, searchEnd)
    : findContiguousMatches(currentEntries, matchOps, searchStart, searchEnd).map((start) => contiguousMatchToSparseMatch(hunk.ops, start));
  if (matches.length === 0) {
    throw new StaleHunkError(`Hunk ${hunkIndex} match pattern ${matchPattern.join(" ")} was not found${renderAnchorSearchScope(hunk)}.`);
  }
  if (matches.length > 1) {
    throw new AmbiguousHunkError(
      `Hunk ${hunkIndex} match pattern ${matchPattern.join(" ")} matched ${matches.length} spans${renderAnchorSearchScope(hunk)}.`
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
      matcherKinds: buildMatcherKinds(hunk),
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
  return hasMatchLocator(op) && (op.hash === undefined || op.hash === line.hash.slice(0, op.hash.length)) && textSelectorMatches(line.content, op);
}

function textSelectorMatches(content: string, op: MatchPatchOp): boolean {
  if (op.combinedSelector !== undefined) return combinedSelectorMatches(content, op.combinedSelector);
  if (op.content === undefined) return true;
  if (op.textSelector === "prefix") return content.startsWith(op.content);
  if (op.textSelector === "contains") return content.includes(op.content);
  if (op.textSelector === "suffix") return content.endsWith(op.content);
  return content === op.content;
}

function combinedSelectorMatches(content: string, selector: NonNullable<MatchPatchOp["combinedSelector"]>): boolean {
  return (
    (selector.prefix === undefined || content.startsWith(selector.prefix)) &&
    (selector.contains === undefined || selector.contains.every((needle) => content.includes(needle))) &&
    (selector.suffix === undefined || content.endsWith(selector.suffix))
  );
}

function hasMatchLocator(op: MatchPatchOp): boolean {
  return op.hash !== undefined || op.content !== undefined || op.combinedSelector !== undefined;
}

function hunkHasSparseRange(hunk: Hunk): boolean {
  return hunk.ops.some((op) => op.kind === "range");
}

function getAnchorSearchStart(hunk: Hunk): number {
  return hunk.anchorHint ? hunk.anchorHint.line - 1 : 0;
}

function getAnchorSearchEnd(hunk: Hunk): number | undefined {
  return hunk.anchorHint?.endLine;
}

function renderAnchorSearchScope(hunk: Hunk): string {
  if (!hunk.anchorHint) return "";
  return hunk.anchorHint.endLine === undefined
    ? ` at or after line ${hunk.anchorHint.line}`
    : ` within lines ${hunk.anchorHint.line}...${hunk.anchorHint.endLine}`;
}

function buildMatchPattern(hunk: Hunk): string[] {
  return hunk.ops.flatMap((op) => {
    if (op.kind === "insert") return [];
    if (op.kind === "range") return [renderRangeLocator(op.rangeKind)];
    return [renderMatchLocator(op)];
  });
}

function buildMatcherKinds(hunk: Hunk): PatchMatcherKind[] {
  return hunk.ops.flatMap((op) => {
    if (op.kind === "insert") return [];
    if (op.kind === "range") return ["range"];
    if (op.unifiedDiff === true) return ["unifiedDiff"];
    if (op.hash !== undefined) return ["hash"];
    if (op.combinedSelector !== undefined) return ["combined"];
    if (op.textSelector === "prefix") return ["prefix"];
    if (op.textSelector === "contains") return ["contains"];
    if (op.textSelector === "suffix") return ["suffix"];
    return ["exact"];
  });
}

function renderRangeLocator(rangeKind: "context" | "delete"): string {
  return `${rangeKind === "context" ? " " : "-"}...`;
}

function renderMatchLocator(op: MatchPatchOp): string {
  if (!hasMatchLocator(op)) return "<missing locator>";
  if (op.hash !== undefined && (op.content !== undefined || op.combinedSelector !== undefined)) return "<invalid hash+text locator>";
  if (op.content !== undefined && op.combinedSelector !== undefined) return "<invalid mixed text locator>";
  if (op.hash !== undefined) return `${op.kind === "context" ? " #" : "-#"}${op.hash}`;
  if (op.combinedSelector !== undefined) return `${op.kind === "context" ? " ?" : "-?"}${JSON.stringify(op.combinedSelector)}`;
  const prefix = op.kind === "context" ? " :" : "-:";
  if (op.textSelector === "prefix") return `${op.kind === "context" ? " ^" : "-^"}${op.content ?? ""}`;
  if (op.textSelector === "contains") return `${op.kind === "context" ? " *" : "-*"}${op.content ?? ""}`;
  if (op.textSelector === "suffix") return `${op.kind === "context" ? " $" : "-$"}${op.content ?? ""}`;
  return `${prefix}${op.content ?? ""}`;
}

function validateSparseRanges(hunk: Hunk, hunkIndex: number): void {
  for (const [opIndex, op] of hunk.ops.entries()) {
    if (op.kind !== "range") continue;
    const previousAnchorOp = findNearestMatchOp(hunk.ops, opIndex, -1);
    const nextAnchorOp = findNearestMatchOp(hunk.ops, opIndex, 1);
    if (!previousAnchorOp || !nextAnchorOp) {
      throw new UnsupportedHunkError(`Hunk ${hunkIndex} '${renderRangeLocator(op.rangeKind)}' must be between context/deletion operations.`);
    }
  }
}

function validateHunkAnchorHint(hunk: Hunk, hunkIndex: number): void {
  if (!hunk.anchorHint) return;
  if (!Number.isSafeInteger(hunk.anchorHint.line) || hunk.anchorHint.line < 1) {
    throw new InvalidPatchError(`Hunk ${hunkIndex} anchor hint line must be a safe positive integer.`);
  }
  if (hunk.anchorHint.endLine !== undefined && (!Number.isSafeInteger(hunk.anchorHint.endLine) || hunk.anchorHint.endLine < 1 || hunk.anchorHint.line > hunk.anchorHint.endLine)) {
    throw new InvalidPatchError(`Hunk ${hunkIndex} anchor hint range must use safe positive integers with start less than or equal to end.`);
  }
}

function validateNoConflictingLocators(hunk: Hunk, hunkIndex: number): void {
  for (const op of hunk.ops) {
    if (isMatchOp(op) && op.hash !== undefined && (op.content !== undefined || op.combinedSelector !== undefined)) {
      throw new InvalidPatchError(`Hunk ${hunkIndex} hash+text locators are not supported; use hash-only ( #HASH/-#HASH, 3 or 4 chars) or text-only ( :text/-:text,  ^prefix/-^prefix,  *needle/-*needle,  ?{...}/-?{...}, or  $suffix/-$suffix).`);
    }
    if (isMatchOp(op) && op.content !== undefined && op.combinedSelector !== undefined) {
      throw new InvalidPatchError(`Hunk ${hunkIndex} mixed text locators are not supported; use exactly one text locator form ( :text/-:text,  ^prefix/-^prefix,  *needle/-*needle,  ?{...}/-?{...}, or  $suffix/-$suffix).`);
    }
    if (isMatchOp(op) && op.combinedSelector !== undefined) {
      op.combinedSelector = normalizeCombinedTextSelector(op.combinedSelector, `Hunk ${hunkIndex} combined selector`);
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

function findSparseMatches(entries: CurrentLineEntry[], ops: readonly Hunk["ops"][number][], maxMatches: number, searchStart = 0, searchEnd = entries.length): SparseMatch[] {
  const matches: SparseMatch[] = [];
  for (let start = searchStart; start <= entries.length && start <= searchEnd && matches.length < maxMatches; start += 1) {
    collectSparseMatches({ entries, ops, opIndex: 0, position: start, start, searchEnd, lineIndexes: new Map(), ranges: new Map(), matches, maxMatches });
  }
  return matches;
}

function collectSparseMatches(state: {
  entries: CurrentLineEntry[];
  ops: readonly Hunk["ops"][number][];
  opIndex: number;
  position: number;
  start: number;
  searchEnd: number;
  lineIndexes: Map<number, number>;
  ranges: Map<number, { start: number; end: number }>;
  matches: SparseMatch[];
  maxMatches: number;
}): void {
  if (state.matches.length >= state.maxMatches) return;
  const opIndex = nextMatchOpIndex(state.ops, state.opIndex);
  if (opIndex === undefined) {
    if (state.position <= state.searchEnd) {
      state.matches.push({ start: state.start, end: state.position, lineIndexes: state.lineIndexes, ranges: state.ranges });
    }
    return;
  }

  const op = state.ops[opIndex];
  if (isMatchOp(op)) {
    if (state.position >= state.searchEnd) return;
    const entry = state.entries[state.position];
    if (!entry || !lineMatchesOp(entry, op)) return;
    const lineIndexes = new Map(state.lineIndexes);
    lineIndexes.set(opIndex, state.position);
    collectSparseMatches({ ...state, opIndex: opIndex + 1, position: state.position + 1, lineIndexes });
    return;
  }

  for (let end = state.position; end <= state.entries.length && end <= state.searchEnd && state.matches.length < state.maxMatches; end += 1) {
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

function findContiguousMatches(entries: CurrentLineEntry[], sequence: readonly MatchPatchOp[], searchStart = 0, searchEnd = entries.length): number[] {
  const matches: number[] = [];
  const lastStart = Math.min(entries.length - sequence.length, searchEnd - sequence.length);
  for (let index = searchStart; index <= lastStart; index += 1) {
    if (sequence.every((op, offset) => lineMatchesOp(entries[index + offset], op))) {
      matches.push(index);
      if (matches.length >= 2) break;
    }
  }
  return matches;
}
