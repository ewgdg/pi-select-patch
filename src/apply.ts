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

export type PatchMatcherKind = "exact" | "prefix" | "contains" | "suffix" | "subsequence" | "hash" | "combined" | "range" | "unifiedDiff";

export interface PatchHunkAudit {
  hunkIndex: number;
  matchStart: number | null;
  matchPattern: string[];
  matcherKinds: PatchMatcherKind[];
  patchCharCount: number;
  baselineCharCount: number;
  locatorPatchCharCount: number;
  locatorBaselineCharCount: number;
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
  lines: PatchLineState[];
  receipt: PatchHunkReceipt;
  transcript: PatchHunkTranscript;
  audit: PatchHunkAudit;
}

type SmartMatcherKind = Extract<PatchMatcherKind, "exact" | "prefix" | "suffix" | "contains" | "subsequence">;

const SMART_MATCH_RANKS: Record<SmartMatcherKind, number> = {
  exact: 0,
  prefix: 1,
  suffix: 1,
  contains: 2,
  subsequence: 3
};
const SMART_MATCH_CANDIDATE_LIMIT = 1000;

interface ResolvedHunkMatch {
  match: SparseMatch;
  smartMatcherKinds: Map<number, PatchMatcherKind>;
}

interface SmartHunkCandidate extends ResolvedHunkMatch {}

interface PatchLineState {
  content: string;
  // Hunks in one update section are Codex/unified-diff-like: later hunks may only
  // anchor on untouched original target lines, not earlier insertions or reused context.
  availableForHunkMatch: boolean;
}

export function applyPatchToText(
  text: string,
  patchInput: string | Patch,
  options: ApplyPatchOptions = {}
): ApplyPatchResult {
  const hashFn = options.hashFn ?? hashLine;
  const patch = typeof patchInput === "string" ? parsePatch(patchInput, hashFn) : patchInput;
  const model = parseText(text);
  let currentLines = model.lines.map((content) => ({ content, availableForHunkMatch: true }));
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
    lines: currentLines.map((line) => line.content),
    finalNewline: currentLines.length > 0 ? model.finalNewline : false
  });
  const entries = toHashLines(currentLines.map((line) => line.content), hashFn);
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

function applyHunk(lines: PatchLineState[], hunk: Hunk, hunkIndex: number, hashFn: HashFunction): AppliedHunk {
  validateHunkAnchorHint(hunk, hunkIndex);
  validateNoConflictingLocators(hunk, hunkIndex);
  const matchPattern = buildMatchPattern(hunk);

  if (matchPattern.length === 0) {
    if (hunk.anchorHint) {
      throw new UnsupportedHunkError(`Hunk ${hunkIndex} anchor hint requires at least one context/deletion locator.`, hunkErrorLocation(hunk));
    }
    if (lines.length === 0 && hunk.ops.every((op) => op.kind === "insert")) {
      const insertedHashes = hunk.ops.map((op) => hashFn(op.content));
      const insertedPatchCharCount = hunk.ops.reduce((total, op) => total + authoredCharCount(op, prefixedLineCharCount(op.content)), 0);
      const insertedBaselineCharCount = hunk.ops.reduce((total, op) => total + prefixedLineCharCount(op.content), 0);
      return {
        lines: hunk.ops.map((op) => ({ content: op.content, availableForHunkMatch: false })),
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
          patchCharCount: insertedPatchCharCount,
          baselineCharCount: insertedBaselineCharCount,
          locatorPatchCharCount: 0,
          locatorBaselineCharCount: 0,
          survivingContextHashes: [],
          insertedHashes,
          deletedHashes: []
        }
      };
    }
    throw new UnsupportedHunkError(`Hunk ${hunkIndex} has no context/deletion locators; pure insertion requires an empty file.`, hunkErrorLocation(hunk));
  }

  validateSparseRanges(hunk, hunkIndex);

  const currentEntries = lines.map((line) => ({ content: line.content, hash: hashFn(line.content), availableForHunkMatch: line.availableForHunkMatch }));
  const matchOps = hunk.ops.filter(isMatchOp);
  const searchStart = getAnchorSearchStart(hunk);
  const searchEnd = getAnchorSearchEnd(hunk);
  const resolvedMatch = findResolvedHunkMatch(currentEntries, hunk, matchOps, searchStart, searchEnd);
  if (!resolvedMatch) {
    throw new StaleHunkError(`Hunk not found${renderAnchorSearchScope(hunk)}.`, hunkErrorLocation(hunk));
  }

  const { match } = resolvedMatch;
  const replacement: PatchLineState[] = [];
  const receiptLines: PatchReceiptLine[] = [];
  const survivingContextHashes: string[] = [];
  const insertedHashes: string[] = [];
  const deletedHashes: string[] = [];
  const transcriptLines: PatchTranscriptLine[] = [];
  let patchCharCount = 0;
  let baselineCharCount = 0;
  let locatorPatchCharCount = 0;
  let locatorBaselineCharCount = 0;

  for (const [opIndex, op] of hunk.ops.entries()) {
    if (op.kind === "insert") {
      patchCharCount += authoredCharCount(op, prefixedLineCharCount(op.content));
      baselineCharCount += prefixedLineCharCount(op.content);
      replacement.push({ content: op.content, availableForHunkMatch: false });
      transcriptLines.push({ kind: "insert", content: op.content });
      const insertedHash = hashFn(op.content);
      insertedHashes.push(insertedHash);
      receiptLines.push({ kind: "insert", hash: insertedHash });
      continue;
    }

    if (op.kind === "range") {
      const authoredRangeCharCount = authoredCharCount(op, renderRangeLocator(op.rangeKind).length);
      patchCharCount += authoredRangeCharCount;
      locatorPatchCharCount += authoredRangeCharCount;
      const range = match.ranges.get(opIndex);
      if (!range) {
        throw new Error("Internal patch error: missing sparse range match.");
      }
      if (op.rangeKind === "context") {
        const baselineRangeCharCount = rangeCharCount(lines, range.start, range.end);
        baselineCharCount += baselineRangeCharCount;
        locatorBaselineCharCount += baselineRangeCharCount;
        replacement.push(...lines.slice(range.start, range.end).map(markLineTouched));
        transcriptLines.push({ kind: "contextRange", content: renderSkippedContextRange(range.end - range.start) });
      } else {
        for (let lineIndex = range.start; lineIndex < range.end; lineIndex += 1) {
          const targetContent = lines[lineIndex].content;
          const baselineLineCharCount = prefixedLineCharCount(targetContent);
          baselineCharCount += baselineLineCharCount;
          locatorBaselineCharCount += baselineLineCharCount;
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
    const targetContent = lines[targetIndex].content;
    const authoredLocatorCharCount = authoredCharCount(op, renderMatchLocator(op).length);
    const baselineLocatorCharCount = prefixedLineCharCount(targetContent);
    patchCharCount += authoredLocatorCharCount;
    baselineCharCount += baselineLocatorCharCount;
    locatorPatchCharCount += authoredLocatorCharCount;
    locatorBaselineCharCount += baselineLocatorCharCount;
    const targetHash = hashFn(targetContent);
    if (op.kind === "context") {
      replacement.push(markLineTouched(lines[targetIndex]));
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
      matcherKinds: buildMatcherKinds(currentEntries, hunk, match, resolvedMatch.smartMatcherKinds),
      patchCharCount,
      baselineCharCount,
      locatorPatchCharCount,
      locatorBaselineCharCount,
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
  availableForHunkMatch: boolean;
}

type LineMatcher = (line: CurrentLineEntry, op: MatchPatchOp) => boolean;

function lineMatchesOp(line: CurrentLineEntry, op: MatchPatchOp): boolean {
  return line.availableForHunkMatch && hasMatchLocator(op) && (op.hash === undefined || op.hash === line.hash.slice(0, op.hash.length)) && textSelectorMatches(line.content, op);
}

function markLineTouched(line: PatchLineState): PatchLineState {
  return { content: line.content, availableForHunkMatch: false };
}

function textSelectorMatches(content: string, op: MatchPatchOp): boolean {
  if (op.combinedSelector !== undefined) return combinedSelectorMatches(content, op.combinedSelector);
  if (op.content === undefined) return true;
  if (op.smart === true) return bestSmartMatcherKind(op.content, content) !== undefined;
  if (op.textSelector === "prefix") return content.startsWith(op.content);
  if (op.textSelector === "contains") return content.includes(op.content);
  if (op.textSelector === "suffix") return content.endsWith(op.content);
  return content === op.content;
}

function bestSmartMatcherKind(query: string, targetLine: string): SmartMatcherKind | undefined {
  if (targetLine === query) return "exact";
  if (query.length < 1) return undefined;
  if (targetLine.startsWith(query)) return "prefix";
  if (targetLine.endsWith(query)) return "suffix";
  if (targetLine.includes(query)) return "contains";
  if (smartTokenSubsequenceMatches(targetLine, query)) return "subsequence";
  return undefined;
}

function smartTokenSubsequenceMatches(content: string, query: string): boolean {
  const queryTokens = tokenizeSmartLocator(query);
  if (queryTokens.length < 1) return false;

  const targetTokens = tokenizeSmartLocator(content);
  let targetIndex = 0;
  for (const queryToken of queryTokens) {
    targetIndex = targetTokens.findIndex((targetToken, offset) => offset >= targetIndex && targetToken === queryToken);
    if (targetIndex === -1) return false;
    targetIndex += 1;
  }
  return true;
}

function tokenizeSmartLocator(text: string): string[] {
  return text.split(/\s+/).filter((token) => token.length > 0);
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

function findResolvedHunkMatch(
  entries: CurrentLineEntry[],
  hunk: Hunk,
  matchOps: readonly MatchPatchOp[],
  searchStart: number,
  searchEnd: number | undefined
): ResolvedHunkMatch | undefined {
  if (!hunkHasSmartLocator(hunk)) {
    const matches = hunkHasSparseRange(hunk)
      ? findSparseMatches(entries, hunk.ops, 2, searchStart, searchEnd)
      : findContiguousMatches(entries, matchOps, searchStart, searchEnd).map((start) => contiguousMatchToSparseMatch(hunk.ops, start));

    if (matches.length > 1) {
      throw new AmbiguousHunkError(`Hunk matched ${matches.length} spans${renderAnchorSearchScope(hunk)}.`, hunkErrorLocation(hunk));
    }
    if (matches.length === 1) {
      return { match: matches[0], smartMatcherKinds: new Map() };
    }
    return undefined;
  }

  const candidates = hunkHasSparseRange(hunk)
    ? findSparseSmartMatchCandidates(entries, hunk.ops, searchStart, searchEnd)
    : findContiguousSmartMatchCandidates(entries, hunk.ops, searchStart, searchEnd);

  if (candidates.length > SMART_MATCH_CANDIDATE_LIMIT) {
    throw new AmbiguousHunkError(`Hunk exceeded smart match candidate cap (${SMART_MATCH_CANDIDATE_LIMIT})${renderAnchorSearchScope(hunk)}.`, hunkErrorLocation(hunk));
  }
  if (candidates.length === 0) return undefined;

  const bestCandidates = nonDominatedSmartCandidates(candidates, smartOpIndexes(hunk.ops));
  if (bestCandidates.length !== 1) {
    throw new AmbiguousHunkError(`Hunk matched ${candidates.length} smart candidates with ${bestCandidates.length} non-dominated winners${renderAnchorSearchScope(hunk)}.`, hunkErrorLocation(hunk));
  }
  return bestCandidates[0];
}

function hunkHasSmartLocator(hunk: Hunk): boolean {
  return hunk.ops.some((op) => isMatchOp(op) && op.smart === true);
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

function hunkErrorLocation(hunk: Hunk): { inputLine?: number } | undefined {
  return { inputLine: hunk.ops.find(isMatchOp)?.inputLine ?? hunk.inputLine };
}

function patchErrorLocation(source: Hunk | Hunk["ops"][number], fallback?: Hunk): { inputLine?: number } | undefined {
  return { inputLine: source.inputLine ?? fallback?.inputLine };
}

function buildMatcherKinds(entries: readonly CurrentLineEntry[], hunk: Hunk, match?: SparseMatch, smartMatcherKinds?: ReadonlyMap<number, PatchMatcherKind>): PatchMatcherKind[] {
  return hunk.ops.flatMap((op, opIndex) => {
    if (op.kind === "insert") return [];
    if (op.kind === "range") return ["range"];
    if (op.unifiedDiff === true) return ["unifiedDiff"];
    if (op.smart === true) return [smartMatcherKinds?.get(opIndex) ?? resolvedSmartMatcherKind(entries, opIndex, op, match)];
    if (op.hash !== undefined) return ["hash"];
    if (op.combinedSelector !== undefined) return ["combined"];
    if (op.textSelector === "prefix") return ["prefix"];
    if (op.textSelector === "contains") return ["contains"];
    if (op.textSelector === "suffix") return ["suffix"];
    return ["exact"];
  });
}

function resolvedSmartMatcherKind(entries: readonly CurrentLineEntry[], opIndex: number, op: MatchPatchOp, match?: SparseMatch): PatchMatcherKind {
  const targetIndex = match?.lineIndexes.get(opIndex);
  const targetContent = targetIndex === undefined ? undefined : entries[targetIndex]?.content;
  if (targetContent !== undefined && op.content !== undefined) {
    const matcherKind = bestSmartMatcherKind(op.content, targetContent);
    if (matcherKind !== undefined) return matcherKind;
  }
  return "exact";
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
  if (op.smart === true) return `${op.kind === "context" ? " ~" : "-~"}${op.content ?? ""}`;
  const prefix = op.kind === "context" ? " :" : "-:";
  if (op.textSelector === "prefix") return `${op.kind === "context" ? " ^" : "-^"}${op.content ?? ""}`;
  if (op.textSelector === "contains") return `${op.kind === "context" ? " *" : "-*"}${op.content ?? ""}`;
  if (op.textSelector === "suffix") return `${op.kind === "context" ? " $" : "-$"}${op.content ?? ""}`;
  return `${prefix}${op.content ?? ""}`;
}

function prefixedLineCharCount(content: string): number {
  return content.length + 1;
}

function authoredCharCount(op: Hunk["ops"][number], fallback: number): number {
  return op.authoredCharCount ?? fallback;
}

function rangeCharCount(lines: readonly PatchLineState[], start: number, end: number): number {
  let total = 0;
  for (let index = start; index < end; index += 1) {
    total += prefixedLineCharCount(lines[index].content);
  }
  return total;
}

function validateSparseRanges(hunk: Hunk, hunkIndex: number): void {
  for (const [opIndex, op] of hunk.ops.entries()) {
    if (op.kind !== "range") continue;
    const previousAnchorOp = findNearestMatchOp(hunk.ops, opIndex, -1);
    const nextAnchorOp = findNearestMatchOp(hunk.ops, opIndex, 1);
    if (!previousAnchorOp || !nextAnchorOp) {
      throw new UnsupportedHunkError(`Hunk ${hunkIndex} range must be between context/deletion operations.`, patchErrorLocation(op, hunk));
    }
  }
}

function validateHunkAnchorHint(hunk: Hunk, hunkIndex: number): void {
  if (!hunk.anchorHint) return;
  if (!Number.isSafeInteger(hunk.anchorHint.line) || hunk.anchorHint.line < 1) {
    throw new InvalidPatchError(`Hunk ${hunkIndex} anchor hint line must be a safe positive integer.`, patchErrorLocation(hunk));
  }
  if (hunk.anchorHint.endLine !== undefined && (!Number.isSafeInteger(hunk.anchorHint.endLine) || hunk.anchorHint.endLine < 1 || hunk.anchorHint.line > hunk.anchorHint.endLine)) {
    throw new InvalidPatchError(`Hunk ${hunkIndex} anchor hint range must use safe positive integers with start less than or equal to end.`, patchErrorLocation(hunk));
  }
}

function validateNoConflictingLocators(hunk: Hunk, hunkIndex: number): void {
  for (const op of hunk.ops) {
    if (isMatchOp(op) && op.smart === true && op.content === undefined) {
      throw new InvalidPatchError(`Hunk ${hunkIndex} smart locators require text content.`, patchErrorLocation(op, hunk));
    }
    if (isMatchOp(op) && op.hash !== undefined && (op.content !== undefined || op.combinedSelector !== undefined)) {
      throw new InvalidPatchError(`Hunk ${hunkIndex} hash+text locators are not supported. Use hash-only or text-only locator.`, patchErrorLocation(op, hunk));
    }
    if (isMatchOp(op) && op.content !== undefined && op.combinedSelector !== undefined) {
      throw new InvalidPatchError(`Hunk ${hunkIndex} mixed text locators are not supported. Use exactly one text locator form.`, patchErrorLocation(op, hunk));
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

function findContiguousSmartMatchCandidates(entries: CurrentLineEntry[], ops: readonly Hunk["ops"][number][], searchStart = 0, searchEnd = entries.length): SmartHunkCandidate[] {
  const candidates: SmartHunkCandidate[] = [];
  const matchOpCount = ops.filter(isMatchOp).length;
  const lastStart = Math.min(entries.length - matchOpCount, searchEnd - matchOpCount);
  for (let start = searchStart; start <= lastStart; start += 1) {
    const candidate = contiguousSmartMatchCandidateAt(entries, ops, start);
    if (!candidate) continue;
    candidates.push(candidate);
    if (candidates.length > SMART_MATCH_CANDIDATE_LIMIT) break;
  }
  return candidates;
}

function contiguousSmartMatchCandidateAt(entries: readonly CurrentLineEntry[], ops: readonly Hunk["ops"][number][], start: number): SmartHunkCandidate | undefined {
  const lineIndexes = new Map<number, number>();
  const smartMatcherKinds = new Map<number, PatchMatcherKind>();
  let consumed = 0;
  for (const [opIndex, op] of ops.entries()) {
    if (!isMatchOp(op)) continue;
    const targetIndex = start + consumed;
    const matcherKind = matchSmartCandidateLine(entries[targetIndex], op);
    if (matcherKind === undefined) return undefined;
    lineIndexes.set(opIndex, targetIndex);
    if (op.smart === true) smartMatcherKinds.set(opIndex, matcherKind);
    consumed += 1;
  }
  return {
    match: { start, end: start + consumed, lineIndexes, ranges: new Map() },
    smartMatcherKinds
  };
}

function findSparseSmartMatchCandidates(entries: CurrentLineEntry[], ops: readonly Hunk["ops"][number][], searchStart = 0, searchEnd = entries.length): SmartHunkCandidate[] {
  const candidates: SmartHunkCandidate[] = [];
  for (let start = searchStart; start <= entries.length && start <= searchEnd && candidates.length <= SMART_MATCH_CANDIDATE_LIMIT; start += 1) {
    collectSparseSmartMatchCandidates({
      entries,
      ops,
      opIndex: 0,
      position: start,
      start,
      searchEnd,
      lineIndexes: new Map(),
      ranges: new Map(),
      smartMatcherKinds: new Map(),
      candidates
    });
  }
  return candidates;
}

function collectSparseSmartMatchCandidates(state: {
  entries: CurrentLineEntry[];
  ops: readonly Hunk["ops"][number][];
  opIndex: number;
  position: number;
  start: number;
  searchEnd: number;
  lineIndexes: Map<number, number>;
  ranges: Map<number, { start: number; end: number }>;
  smartMatcherKinds: Map<number, PatchMatcherKind>;
  candidates: SmartHunkCandidate[];
}): void {
  if (state.candidates.length > SMART_MATCH_CANDIDATE_LIMIT) return;
  const opIndex = nextMatchOpIndex(state.ops, state.opIndex);
  if (opIndex === undefined) {
    if (state.position <= state.searchEnd) {
      state.candidates.push({
        match: { start: state.start, end: state.position, lineIndexes: state.lineIndexes, ranges: state.ranges },
        smartMatcherKinds: state.smartMatcherKinds
      });
    }
    return;
  }

  const op = state.ops[opIndex];
  if (isMatchOp(op)) {
    if (state.position >= state.searchEnd) return;
    const matcherKind = matchSmartCandidateLine(state.entries[state.position], op);
    if (matcherKind === undefined) return;
    const lineIndexes = new Map(state.lineIndexes);
    lineIndexes.set(opIndex, state.position);
    const smartMatcherKinds = op.smart === true ? new Map(state.smartMatcherKinds).set(opIndex, matcherKind) : state.smartMatcherKinds;
    collectSparseSmartMatchCandidates({ ...state, opIndex: opIndex + 1, position: state.position + 1, lineIndexes, smartMatcherKinds });
    return;
  }

  for (let end = state.position; end <= state.entries.length && end <= state.searchEnd && state.candidates.length <= SMART_MATCH_CANDIDATE_LIMIT; end += 1) {
    if (!rangeIsAvailableForHunkMatch(state.entries, state.position, end)) continue;
    const ranges = new Map(state.ranges);
    ranges.set(opIndex, { start: state.position, end });
    collectSparseSmartMatchCandidates({ ...state, opIndex: opIndex + 1, position: end, ranges });
  }
}

function matchSmartCandidateLine(line: CurrentLineEntry | undefined, op: MatchPatchOp): PatchMatcherKind | undefined {
  if (!line || !line.availableForHunkMatch || !hasMatchLocator(op)) return undefined;
  if (op.hash !== undefined && op.hash !== line.hash.slice(0, op.hash.length)) return undefined;
  if (op.smart !== true) return textSelectorMatches(line.content, op) ? "exact" : undefined;
  if (op.content === undefined) return undefined;
  return bestSmartMatcherKind(op.content, line.content);
}

function smartOpIndexes(ops: readonly Hunk["ops"][number][]): number[] {
  return ops.flatMap((op, opIndex) => (isMatchOp(op) && op.smart === true ? [opIndex] : []));
}

function nonDominatedSmartCandidates(candidates: readonly SmartHunkCandidate[], smartIndexes: readonly number[]): SmartHunkCandidate[] {
  return candidates.filter((candidate) => !candidates.some((other) => other !== candidate && smartCandidateDominates(other, candidate, smartIndexes)));
}

function smartCandidateDominates(left: SmartHunkCandidate, right: SmartHunkCandidate, smartIndexes: readonly number[]): boolean {
  let hasBetterRow = false;
  for (const opIndex of smartIndexes) {
    const leftRank = smartMatcherRank(left.smartMatcherKinds.get(opIndex));
    const rightRank = smartMatcherRank(right.smartMatcherKinds.get(opIndex));
    if (leftRank > rightRank) return false;
    if (leftRank < rightRank) hasBetterRow = true;
  }
  return hasBetterRow;
}

function smartMatcherRank(kind: PatchMatcherKind | undefined): number {
  if (kind === "exact" || kind === "prefix" || kind === "suffix" || kind === "contains" || kind === "subsequence") {
    return SMART_MATCH_RANKS[kind];
  }
  throw new Error("Internal patch error: missing smart matcher kind.");
}

function findSparseMatches(entries: CurrentLineEntry[], ops: readonly Hunk["ops"][number][], maxMatches: number, searchStart = 0, searchEnd = entries.length, lineMatcher: LineMatcher = lineMatchesOp): SparseMatch[] {
  const matches: SparseMatch[] = [];
  for (let start = searchStart; start <= entries.length && start <= searchEnd && matches.length < maxMatches; start += 1) {
    collectSparseMatches({ entries, ops, opIndex: 0, position: start, start, searchEnd, lineIndexes: new Map(), ranges: new Map(), matches, maxMatches, lineMatcher });
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
  lineMatcher: LineMatcher;
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
    if (!entry || !state.lineMatcher(entry, op)) return;
    const lineIndexes = new Map(state.lineIndexes);
    lineIndexes.set(opIndex, state.position);
    collectSparseMatches({ ...state, opIndex: opIndex + 1, position: state.position + 1, lineIndexes });
    return;
  }

  for (let end = state.position; end <= state.entries.length && end <= state.searchEnd && state.matches.length < state.maxMatches; end += 1) {
    if (!rangeIsAvailableForHunkMatch(state.entries, state.position, end)) continue;
    const ranges = new Map(state.ranges);
    ranges.set(opIndex, { start: state.position, end });
    collectSparseMatches({ ...state, opIndex: opIndex + 1, position: end, ranges });
  }
}

function rangeIsAvailableForHunkMatch(entries: readonly CurrentLineEntry[], start: number, end: number): boolean {
  return entries.slice(start, end).every((entry) => entry.availableForHunkMatch);
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

function findContiguousMatches(entries: CurrentLineEntry[], sequence: readonly MatchPatchOp[], searchStart = 0, searchEnd = entries.length, lineMatcher: LineMatcher = lineMatchesOp): number[] {
  const matches: number[] = [];
  const lastStart = Math.min(entries.length - sequence.length, searchEnd - sequence.length);
  for (let index = searchStart; index <= lastStart; index += 1) {
    if (sequence.every((op, offset) => lineMatcher(entries[index + offset], op))) {
      matches.push(index);
      if (matches.length >= 2) break;
    }
  }
  return matches;
}
