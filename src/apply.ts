import { AmbiguousHunkError, ConflictingHunksError, HunkCandidateLimitError, InvalidPatchError, StaleHunkError, UnsupportedHunkError } from "./errors.js";
import { type HashFunction, hashLine } from "./hash.js";
import { normalizeCombinedTextSelector, parsePatch, type Hunk, type MatchPatchOp, type Patch, type ReplacePatchOp } from "./patch-format.js";
import { renderHashLines, toHashLines, type HashLineEntry } from "./read-format.js";
import { parseText, serializeText } from "./text-lines.js";

export type AnchorMode = "strict" | "tolerant";

export interface ApplyPatchOptions {
  hashFn?: HashFunction;
  anchorMode?: AnchorMode;
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

export type PatchMatcherKind = "exact" | "prefix" | "contains" | "suffix" | "subsequence" | "fuzzy" | "charSubsequence" | "hash" | "combined" | "range" | "unifiedDiff";

export type AnchorAffinity = "contained" | "overlapping" | "outside";

export interface ToleratedAnchorResolution {
  affinity: Exclude<AnchorAffinity, "contained">;
  authoredAnchor: { startLine: number; endLine?: number };
  resolvedMatch: { startLine: number; endLine: number };
}

export interface OrderAssistedHunkSpan {
  hunkIndex: number;
  startLine: number;
  endLine: number;
}

export interface OrderAssistedResolution {
  groupStartHunk: number;
  groupEndHunk: number;
  selectedSpans: OrderAssistedHunkSpan[];
}

export interface PatchHunkAudit {
  hunkIndex: number;
  matchStart: number | null;
  matchPattern: string[];
  matcherKinds: PatchMatcherKind[];
  patchCharCount: number;
  baselineCharCount: number;
  patchLineCount: number;
  baselineLineCount: number;
  selectorPatchCharCount: number;
  selectorBaselineCharCount: number;
  survivingContextHashes: string[];
  insertedHashes: string[];
  deletedHashes: string[];
  anchorResolution?: ToleratedAnchorResolution;
  orderAssisted?: OrderAssistedResolution;
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

type SmartMatcherKind = Extract<PatchMatcherKind, "exact" | "prefix" | "suffix" | "contains" | "subsequence" | "fuzzy" | "charSubsequence">;

const SMART_MATCH_RANKS: Record<SmartMatcherKind, number> = {
  exact: 0,
  prefix: 1,
  suffix: 1,
  contains: 2,
  subsequence: 3,
  fuzzy: 4,
  charSubsequence: 5
};
const HUNK_CANDIDATE_LIMIT = 1000;
const AMBIGUITY_GROUP_ASSIGNMENT_STATE_LIMIT = 100_000;
const SMART_FUZZY_MIN_TOKEN_LENGTH = 6;
const SMART_FUZZY_TWO_EDIT_TOKEN_LENGTH = 16;
const SMART_FUZZY_SINGLE_TOKEN_MIN_LENGTH = 8;
const SMART_FUZZY_TOTAL_EDIT_LIMIT = 2;
const SMART_CHAR_SUBSEQUENCE_MIN_NON_WHITESPACE = 4;

interface ResolvedHunkMatch {
  match: SparseMatch;
  smartMatcherKinds: Map<number, PatchMatcherKind>;
  smartMatcherEditCosts: Map<number, number>;
  anchorResolution?: ToleratedAnchorResolution;
  orderAssisted?: OrderAssistedResolution;
}

interface HunkMatchSearch {
  start: number;
  end?: number;
  matchFilter?: (match: SparseMatch) => boolean;
  errorScope?: string;
}

interface SmartHunkCandidate extends ResolvedHunkMatch {}

interface SmartMatcherResult {
  kind: SmartMatcherKind;
  editCost: number;
}

interface FuzzySubsequenceScore {
  editCost: number;
}

interface PatchLineState {
  content: string;
  sourceIndex?: number;
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
  const anchorMode = options.anchorMode ?? "strict";
  const patch = typeof patchInput === "string" ? parsePatch(patchInput, hashFn) : patchInput;
  const model = parseText(text);
  const sourceLines = model.lines.map((content, sourceIndex) => ({ content, sourceIndex, availableForHunkMatch: true }));
  const resolvedHunks = resolveSectionHunks(sourceLines, patch.hunks, hashFn, anchorMode);
  let currentLines: PatchLineState[] = sourceLines;
  const hunkReceipts: PatchHunkReceipt[] = [];
  const hunkAudits: PatchHunkAudit[] = [];
  const hunkTranscripts: PatchHunkTranscript[] = [];

  for (const resolvedHunk of resolvedHunks) {
    const applied = applyHunk(
      currentLines,
      resolvedHunk.hunk,
      resolvedHunk.hunkIndex,
      hashFn,
      resolvedHunk.match ? materializeSourceMatch(resolvedHunk.match, currentLines, sourceLines.length) : undefined,
      resolvedHunk.match?.match.start
    );
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

interface ResolvedSectionHunk {
  hunk: Hunk;
  hunkIndex: number;
  match?: ResolvedHunkMatch;
}

interface AmbiguousSectionHunk {
  hunk: Hunk;
  hunkIndex: number;
  candidates: ResolvedHunkMatch[];
}

function resolveSectionHunks(
  sourceLines: readonly PatchLineState[],
  hunks: readonly Hunk[],
  hashFn: HashFunction,
  anchorMode: AnchorMode
): ResolvedSectionHunk[] {
  const entries = sourceLines.map((line) => ({ content: line.content, hash: hashFn(line.content), availableForHunkMatch: true }));
  const resolutions: Array<ResolvedSectionHunk | AmbiguousSectionHunk> = [];

  for (const [hunkOffset, hunk] of hunks.entries()) {
    const hunkIndex = hunkOffset + 1;
    validateHunkAnchorHint(hunk, hunkIndex);
    validateNoConflictingSelectors(hunk, hunkIndex);
    validateReplaceRows(hunk, hunkIndex);
    const matchPattern = buildMatchPattern(hunk);

    if (matchPattern.length === 0) {
      if (hunk.anchorHint) {
        throw new UnsupportedHunkError(`Hunk ${hunkIndex} anchor hint requires at least one context/deletion selector.`, hunkErrorLocation(hunk));
      }
      if (sourceLines.length === 0 && hunk.ops.every((op) => op.kind === "insert")) {
        if (resolutions.some((resolution) => "match" in resolution && resolution.match === undefined)) {
          throw new UnsupportedHunkError(`Hunk ${hunkIndex} has no context/deletion selectors; pure insertion requires an empty file.`, hunkErrorLocation(hunk));
        }
        resolutions.push({ hunk, hunkIndex });
        continue;
      }
      throw new UnsupportedHunkError(`Hunk ${hunkIndex} has no context/deletion selectors; pure insertion requires an empty file.`, hunkErrorLocation(hunk));
    }

    validateSparseRanges(hunk, hunkIndex);
    const matchOps = hunk.ops.filter(isMatchOp);
    const candidates = findHunkCandidatesOrThrow(entries, hunk, matchOps, anchorMode);
    if (candidates.length > 1) {
      resolutions.push({ hunk, hunkIndex, candidates });
      continue;
    }
    const match = candidates[0];
    validateResolvedReplaceRows(sourceLines, hunk, hunkIndex, match.match);
    resolutions.push({ hunk, hunkIndex, match });
  }

  resolveAmbiguityGroups(resolutions, sourceLines);

  const resolved = resolutions as ResolvedSectionHunk[];
  validateResolvedHunkConflicts(resolved);
  return resolved;
}

type AssignmentCardinality = "zero" | "one" | "many";

interface AssignmentSearchResult {
  cardinality: AssignmentCardinality;
  assignment?: ResolvedHunkMatch[];
}

function resolveAmbiguityGroups(
  resolutions: Array<ResolvedSectionHunk | AmbiguousSectionHunk>,
  sourceLines: readonly PatchLineState[]
): void {
  const occupiedMatches = resolutions.flatMap((resolution) =>
    "candidates" in resolution || !resolution.match ? [] : [resolution.match]
  );

  for (let groupStart = 0; groupStart < resolutions.length;) {
    const first = resolutions[groupStart];
    if (!("candidates" in first)) {
      groupStart += 1;
      continue;
    }

    let groupEnd = groupStart + 1;
    while (groupEnd < resolutions.length && "candidates" in resolutions[groupEnd]) groupEnd += 1;
    const group = resolutions.slice(groupStart, groupEnd) as AmbiguousSectionHunk[];
    const conflictFree = searchAssignments(group, occupiedMatches);
    if (conflictFree.cardinality === "zero") {
      throw new ConflictingHunksError(renderConflictingGroupDetail(group), hunkErrorLocation(first.hunk));
    }

    let selected = conflictFree.assignment;
    let orderAssisted = false;
    if (conflictFree.cardinality === "many") {
      const previousBoundary = findNearestResolvedMatch(resolutions, groupStart - 1, -1);
      const nextBoundary = findNearestResolvedMatch(resolutions, groupEnd, 1);
      const internallyOrdered = searchAssignments(group, occupiedMatches, isInternallySourceOrdered);
      const availablePreviousBoundary = previousBoundary && searchAssignments(
        group,
        occupiedMatches,
        (assignment) => isInternallySourceOrdered(assignment) && previousBoundary.match.end <= assignment[0].match.start
      ).cardinality !== "zero" ? previousBoundary : undefined;
      const availableNextBoundary = nextBoundary && searchAssignments(
        group,
        occupiedMatches,
        (assignment) => isInternallySourceOrdered(assignment) && assignment.at(-1)!.match.end <= nextBoundary.match.start
      ).cardinality !== "zero" ? nextBoundary : undefined;
      let ordered = searchAssignments(group, occupiedMatches, (assignment) =>
        isSourceOrderedAssignment(assignment, availablePreviousBoundary, availableNextBoundary)
      );
      // Individually usable boundaries can still be mutually incompatible. If
      // the group itself has one ordered assignment, optional boundaries may
      // not turn that locally resolvable group into a failure.
      if (ordered.cardinality === "zero" && internallyOrdered.cardinality === "one") ordered = internallyOrdered;
      if (ordered.cardinality !== "one") {
        throw new AmbiguousHunkError(renderAmbiguousGroupDetail(group, ordered.cardinality), hunkErrorLocation(first.hunk));
      }
      selected = ordered.assignment;
      orderAssisted = true;
    }

    if (!selected) throw new Error("Internal patch error: missing ambiguity-group assignment.");
    const orderAssistance = orderAssisted ? createOrderAssistedResolution(group, selected) : undefined;
    for (const [offset, candidate] of selected.entries()) {
      const ambiguous = group[offset];
      const match = orderAssistance ? { ...candidate, orderAssisted: orderAssistance } : candidate;
      validateResolvedReplaceRows(sourceLines, ambiguous.hunk, ambiguous.hunkIndex, match.match);
      resolutions[groupStart + offset] = { hunk: ambiguous.hunk, hunkIndex: ambiguous.hunkIndex, match };
    }
    occupiedMatches.push(...selected);
    groupStart = groupEnd;
  }
}

function searchAssignments(
  group: readonly AmbiguousSectionHunk[],
  occupiedMatches: readonly ResolvedHunkMatch[],
  include: (assignment: readonly ResolvedHunkMatch[]) => boolean = () => true
): AssignmentSearchResult {
  const candidateIndexes = new Array<number>(group.length).fill(0);
  const selected: ResolvedHunkMatch[] = [];
  let depth = 0;
  let exploredStates = 0;
  let count = 0;
  let onlyAssignment: ResolvedHunkMatch[] | undefined;

  while (depth >= 0 && count < 2) {
    if (depth === group.length) {
      if (include(selected)) {
        count += 1;
        if (count === 1) onlyAssignment = [...selected];
      }
      depth -= 1;
      selected.pop();
      continue;
    }

    const candidates = group[depth].candidates;
    let selectedCandidate = false;
    while (candidateIndexes[depth] < candidates.length) {
      const candidate = candidates[candidateIndexes[depth]++];
      exploredStates += 1;
      if (exploredStates > AMBIGUITY_GROUP_ASSIGNMENT_STATE_LIMIT) {
        throw new HunkCandidateLimitError(renderAssignmentStateLimitDetail(group, exploredStates), hunkErrorLocation(group[0].hunk));
      }
      if (occupiedMatches.some((occupied) => matchesOverlap(candidate, occupied)) || selected.some((prior) => matchesOverlap(candidate, prior))) continue;
      selected.push(candidate);
      depth += 1;
      if (depth < group.length) candidateIndexes[depth] = 0;
      selectedCandidate = true;
      break;
    }
    if (selectedCandidate) continue;

    candidateIndexes[depth] = 0;
    depth -= 1;
    if (depth >= 0) selected.pop();
  }

  return count === 0 ? { cardinality: "zero" } : count === 1 ? { cardinality: "one", assignment: onlyAssignment } : { cardinality: "many" };
}

function findNearestResolvedMatch(
  resolutions: readonly (ResolvedSectionHunk | AmbiguousSectionHunk)[],
  start: number,
  step: -1 | 1
): ResolvedHunkMatch | undefined {
  for (let index = start; index >= 0 && index < resolutions.length; index += step) {
    const resolution = resolutions[index];
    if (!("candidates" in resolution) && resolution.match) return resolution.match;
  }
  return undefined;
}

function isInternallySourceOrdered(assignment: readonly ResolvedHunkMatch[]): boolean {
  return assignment.every((match, index) => index === 0 || assignment[index - 1].match.end <= match.match.start);
}

function isSourceOrderedAssignment(
  assignment: readonly ResolvedHunkMatch[],
  previousBoundary: ResolvedHunkMatch | undefined,
  nextBoundary: ResolvedHunkMatch | undefined
): boolean {
  if (!isInternallySourceOrdered(assignment)) return false;
  if (previousBoundary && previousBoundary.match.end > assignment[0].match.start) return false;
  if (nextBoundary && assignment.at(-1)!.match.end > nextBoundary.match.start) return false;
  return true;
}

function matchesOverlap(left: ResolvedHunkMatch, right: ResolvedHunkMatch): boolean {
  return left.match.start < right.match.end && right.match.start < left.match.end;
}

function createOrderAssistedResolution(
  group: readonly AmbiguousSectionHunk[],
  selected: readonly ResolvedHunkMatch[]
): OrderAssistedResolution {
  return {
    groupStartHunk: group[0].hunkIndex,
    groupEndHunk: group.at(-1)!.hunkIndex,
    selectedSpans: selected.map((candidate, index) => ({
      hunkIndex: group[index].hunkIndex,
      startLine: candidate.match.start + 1,
      endLine: candidate.match.end
    }))
  };
}

function renderConflictingGroupDetail(group: readonly AmbiguousSectionHunk[]): string {
  return `Ambiguity group hunks ${group[0].hunkIndex}...${group.at(-1)!.hunkIndex} (${renderGroupInputLineRange(group)}; candidates ${renderGroupCandidateSpans(group)}; conflict-free assignments: 0).`;
}

function renderAmbiguousGroupDetail(group: readonly AmbiguousSectionHunk[], cardinality: AssignmentCardinality): string {
  return `Ambiguity group hunks ${group[0].hunkIndex}...${group.at(-1)!.hunkIndex} (${renderGroupInputLineRange(group)}; candidates ${renderGroupCandidateSpans(group)}; source-ordered assignments: ${renderAssignmentCardinality(cardinality)}).`;
}

function renderAssignmentStateLimitDetail(group: readonly AmbiguousSectionHunk[], exploredStates: number): string {
  return `Ambiguity group assignment search exceeded state limit (${AMBIGUITY_GROUP_ASSIGNMENT_STATE_LIMIT}; explored ${exploredStates}+; ${renderGroupInputLineRange(group)}; candidates ${renderGroupCandidateSpans(group)}).`;
}

function renderGroupInputLineRange(group: readonly AmbiguousSectionHunk[]): string {
  const inputLines = group.flatMap((hunk) => hunk.hunk.ops.flatMap((op) => op.inputLine === undefined ? [] : [op.inputLine]));
  if (inputLines.length === 0) return "patch input lines unavailable";
  return `patch input lines ${Math.min(...inputLines)}...${Math.max(...inputLines)}`;
}

function renderGroupCandidateSpans(group: readonly AmbiguousSectionHunk[]): string {
  const rendered = group.slice(0, 4).map((hunk) => {
    const spans = hunk.candidates.slice(0, 4).map((candidate) => `${candidate.match.start + 1}...${candidate.match.end}`).join(",");
    return `hunk ${hunk.hunkIndex}=[${spans}${hunk.candidates.length > 4 ? ",..." : ""}]`;
  });
  return `${rendered.join("; ")}${group.length > 4 ? "; ..." : ""}`;
}

function renderAssignmentCardinality(cardinality: AssignmentCardinality): string {
  return cardinality === "many" ? "2+" : cardinality;
}

function renderHunkCandidateLimitDetail(hunk: Hunk, errorScope: string, matches: readonly SparseMatch[]): string {
  return `Hunk candidate discovery exceeded limit (${HUNK_CANDIDATE_LIMIT}; discovered ${matches.length}+${errorScope}; ${renderHunkInputLineRange(hunk)}; source spans ${renderBoundedSourceSpans(matches)}).`;
}

function renderBoundedSourceSpans(matches: readonly SparseMatch[]): string {
  const rendered = matches.slice(0, 4).map((match) => `${match.start + 1}...${match.end}`).join(",");
  return `${rendered}${matches.length > 4 ? ",..." : ""}`;
}

function renderHunkInputLineRange(hunk: Hunk): string {
  const inputLines = hunk.ops.flatMap((op) => op.inputLine === undefined ? [] : [op.inputLine]);
  if (inputLines.length === 0) return "patch input lines unavailable";
  return `patch input lines ${Math.min(...inputLines)}...${Math.max(...inputLines)}`;
}

function applyHunk(
  lines: PatchLineState[],
  hunk: Hunk,
  hunkIndex: number,
  hashFn: HashFunction,
  resolvedMatch?: ResolvedHunkMatch,
  sourceMatchStart?: number
): AppliedHunk {
  validateHunkAnchorHint(hunk, hunkIndex);
  validateNoConflictingSelectors(hunk, hunkIndex);
  validateReplaceRows(hunk, hunkIndex);
  const matchPattern = buildMatchPattern(hunk);
  const patchLineCount = authoredHunkLineCount(hunk);

  if (matchPattern.length === 0) {
    if (hunk.anchorHint) {
      throw new UnsupportedHunkError(`Hunk ${hunkIndex} anchor hint requires at least one context/deletion selector.`, hunkErrorLocation(hunk));
    }
    if (lines.length === 0 && hunk.ops.every((op) => op.kind === "insert")) {
      const insertedHashes = hunk.ops.map((op) => hashFn(op.content));
      const insertedPatchCharCount = hunk.ops.reduce((total, op) => total + authoredCharCount(op, unifiedDiffLineCharCount("insert", op.content)), 0);
      const insertedBaselineCharCount = hunk.ops.reduce((total, op) => total + unifiedDiffLineCharCount("insert", op.content), 0);
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
          patchLineCount,
          baselineLineCount: hunk.ops.length,
          selectorPatchCharCount: 0,
          selectorBaselineCharCount: 0,
          survivingContextHashes: [],
          insertedHashes,
          deletedHashes: []
        }
      };
    }
    throw new UnsupportedHunkError(`Hunk ${hunkIndex} has no context/deletion selectors; pure insertion requires an empty file.`, hunkErrorLocation(hunk));
  }

  validateSparseRanges(hunk, hunkIndex);

  const currentEntries = lines.map((line) => ({ content: line.content, hash: hashFn(line.content), availableForHunkMatch: line.availableForHunkMatch }));
  if (!resolvedMatch) throw new Error("Internal patch error: missing pre-resolved hunk match.");

  const { match } = resolvedMatch;
  const replacement: PatchLineState[] = [];
  const receiptLines: PatchReceiptLine[] = [];
  const survivingContextHashes: string[] = [];
  const insertedHashes: string[] = [];
  const deletedHashes: string[] = [];
  const transcriptLines: PatchTranscriptLine[] = [];
  let patchCharCount = 0;
  let baselineCharCount = 0;
  let baselineLineCount = 0;
  let selectorPatchCharCount = 0;
  let selectorBaselineCharCount = 0;

  for (const [opIndex, op] of hunk.ops.entries()) {
    if (op.kind === "insert") {
      patchCharCount += authoredCharCount(op, unifiedDiffLineCharCount("insert", op.content));
      baselineCharCount += unifiedDiffLineCharCount("insert", op.content);
      baselineLineCount += 1;
      replacement.push({ content: op.content, availableForHunkMatch: false });
      transcriptLines.push({ kind: "insert", content: op.content });
      const insertedHash = hashFn(op.content);
      insertedHashes.push(insertedHash);
      receiptLines.push({ kind: "insert", hash: insertedHash });
      continue;
    }

    if (op.kind === "range") {
      const authoredRangeCharCount = authoredCharCount(op, renderRangeSelector(op.rangeKind).length);
      patchCharCount += authoredRangeCharCount;
      selectorPatchCharCount += authoredRangeCharCount;
      const range = match.ranges.get(opIndex);
      if (!range) {
        throw new Error("Internal patch error: missing sparse range match.");
      }
      if (op.rangeKind === "context") {
        const baselineRangeCharCount = rangeCharCount(lines, range.start, range.end, "context");
        baselineCharCount += baselineRangeCharCount;
        selectorBaselineCharCount += baselineRangeCharCount;
        baselineLineCount += range.end - range.start;
        replacement.push(...lines.slice(range.start, range.end).map(markLineTouched));
        transcriptLines.push({ kind: "contextRange", content: renderSkippedContextRange(range.end - range.start) });
      } else {
        for (let lineIndex = range.start; lineIndex < range.end; lineIndex += 1) {
          const targetContent = lines[lineIndex].content;
          const baselineLineCharCount = unifiedDiffLineCharCount("delete", targetContent);
          baselineCharCount += baselineLineCharCount;
          selectorBaselineCharCount += baselineLineCharCount;
          baselineLineCount += 1;
          const targetHash = hashFn(targetContent);
          transcriptLines.push({ kind: "delete", content: targetContent });
          deletedHashes.push(targetHash);
        }
      }
      continue;
    }

    if (op.kind === "replace") {
      continue;
    }

    const targetIndex = match.lineIndexes.get(opIndex);
    if (targetIndex === undefined) {
      throw new Error("Internal patch error: missing hash operation match.");
    }
    const targetContent = lines[targetIndex].content;
    const authoredSelectorCharCount = authoredCharCount(op, renderMatchSelector(op).length);
    const baselineSelectorCharCount = unifiedDiffLineCharCount(op.kind, targetContent);
    patchCharCount += authoredSelectorCharCount;
    baselineCharCount += baselineSelectorCharCount;
    selectorPatchCharCount += authoredSelectorCharCount;
    selectorBaselineCharCount += baselineSelectorCharCount;
    const targetHash = hashFn(targetContent);
    if (op.kind === "context") {
      const replaceOps = followingReplaceOps(hunk.ops, opIndex);
      if (replaceOps.length > 0) {
        const replacedContent = applyLineReplaceOps(targetContent, replaceOps, hunkIndex, hunk);
        const replacementPatchCharCount = replaceOps.reduce((total, replaceOp) => total + authoredCharCount(replaceOp, replaceOpAuthoredCharFallback(replaceOp)), 0);
        patchCharCount += replacementPatchCharCount;
        baselineCharCount += unifiedDiffLineCharCount("insert", replacedContent);
        baselineLineCount += 2;
        replacement.push({ content: replacedContent, availableForHunkMatch: false });
        transcriptLines.push({ kind: "delete", content: targetContent });
        transcriptLines.push({ kind: "insert", content: replacedContent });
        deletedHashes.push(targetHash);
        const insertedHash = hashFn(replacedContent);
        insertedHashes.push(insertedHash);
        receiptLines.push({ kind: "insert", hash: insertedHash });
        continue;
      }
      baselineLineCount += 1;
      replacement.push(markLineTouched(lines[targetIndex]));
      transcriptLines.push({ kind: "context", content: targetContent });
      survivingContextHashes.push(targetHash);
      receiptLines.push({ kind: "context", hash: targetHash });
    } else {
      baselineLineCount += 1;
      transcriptLines.push({ kind: "delete", content: targetContent });
      deletedHashes.push(targetHash);
    }
  }

  return {
    lines: [...lines.slice(0, match.start), ...replacement, ...lines.slice(match.end)],
    receipt: { hunkIndex, lines: receiptLines },
    transcript: { hunkIndex, matchStart: sourceMatchStart ?? match.start, lines: transcriptLines },
    audit: {
      hunkIndex,
      matchStart: sourceMatchStart ?? match.start,
      matchPattern,
      matcherKinds: buildMatcherKinds(currentEntries, hunk, match, resolvedMatch.smartMatcherKinds),
      patchCharCount,
      baselineCharCount,
      patchLineCount,
      baselineLineCount,
      selectorPatchCharCount,
      selectorBaselineCharCount,
      survivingContextHashes,
      insertedHashes,
      deletedHashes,
      ...(resolvedMatch.anchorResolution ? { anchorResolution: resolvedMatch.anchorResolution } : {}),
      ...(resolvedMatch.orderAssisted ? { orderAssisted: resolvedMatch.orderAssisted } : {})
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
  return line.availableForHunkMatch && hasMatchSelector(op) && (op.hash === undefined || op.hash === line.hash.slice(0, op.hash.length)) && textSelectorMatches(line.content, op);
}

function markLineTouched(line: PatchLineState): PatchLineState {
  return { ...line, availableForHunkMatch: false };
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
  return bestSmartMatcherResult(query, targetLine)?.kind;
}

function bestSmartMatcherResult(query: string, targetLine: string): SmartMatcherResult | undefined {
  if (targetLine === query) return { kind: "exact", editCost: 0 };
  if (query.length < 1) return undefined;
  if (targetLine.startsWith(query)) return { kind: "prefix", editCost: 0 };
  if (targetLine.endsWith(query)) return { kind: "suffix", editCost: 0 };
  if (targetLine.includes(query)) return { kind: "contains", editCost: 0 };
  if (smartTokenSubsequenceMatches(targetLine, query)) return { kind: "subsequence", editCost: 0 };
  const fuzzyEditCost = fuzzyTokenSubsequenceEditCost(targetLine, query);
  if (fuzzyEditCost !== undefined) return { kind: "fuzzy", editCost: fuzzyEditCost };
  if (smartCharSubsequenceMatches(targetLine, query)) return { kind: "charSubsequence", editCost: 0 };
  return undefined;
}

function smartCharSubsequenceMatches(content: string, query: string): boolean {
  const usefulQueryCharCount = Array.from(query).filter((char) => !/\s/.test(char)).length;
  if (usefulQueryCharCount < SMART_CHAR_SUBSEQUENCE_MIN_NON_WHITESPACE) return false;

  let targetIndex = 0;
  for (const queryChar of query) {
    targetIndex = content.indexOf(queryChar, targetIndex);
    if (targetIndex === -1) return false;
    targetIndex += queryChar.length;
  }
  return true;
}

function smartTokenSubsequenceMatches(content: string, query: string): boolean {
  const queryTokens = tokenizeSmartSelector(query);
  if (queryTokens.length < 1) return false;

  const targetTokens = tokenizeSmartSelector(content);
  let targetIndex = 0;
  for (const queryToken of queryTokens) {
    targetIndex = targetTokens.findIndex((targetToken, offset) => offset >= targetIndex && targetToken === queryToken);
    if (targetIndex === -1) return false;
    targetIndex += 1;
  }
  return true;
}

function tokenizeSmartSelector(text: string): string[] {
  return text.split(/\s+/).filter((token) => token.length > 0);
}

function fuzzyTokenSubsequenceEditCost(content: string, query: string): number | undefined {
  const queryTokens = tokenizeSmartSelector(query);
  if (queryTokens.length < 1) return undefined;
  if (queryTokens.length === 1 && queryTokens[0].length < SMART_FUZZY_SINGLE_TOKEN_MIN_LENGTH) return undefined;

  const targetTokens = tokenizeSmartSelector(content);
  const best = findBestFuzzyTokenSubsequence(queryTokens, targetTokens);
  if (!best) return undefined;
  return best.editCost;
}

function findBestFuzzyTokenSubsequence(queryTokens: readonly string[], targetTokens: readonly string[]): FuzzySubsequenceScore | undefined {
  let previousRow: Array<FuzzySubsequenceScore | undefined> = targetTokens.map(() => ({ editCost: 0 }));
  previousRow.unshift({ editCost: 0 });

  for (const queryToken of queryTokens) {
    const currentRow: Array<FuzzySubsequenceScore | undefined> = [undefined];
    for (let targetIndex = 1; targetIndex <= targetTokens.length; targetIndex += 1) {
      const skippedTargetScore = currentRow[targetIndex - 1];
      const previousTokenScore = previousRow[targetIndex - 1];
      const tokenEditCost = fuzzyTokenEditCost(queryToken, targetTokens[targetIndex - 1]);
      const matchedTokenScore = previousTokenScore && tokenEditCost !== undefined
        ? addFuzzyTokenScore(previousTokenScore, tokenEditCost)
        : undefined;
      currentRow[targetIndex] = betterFuzzySubsequenceScore(skippedTargetScore, matchedTokenScore);
    }
    previousRow = currentRow;
  }

  return previousRow[targetTokens.length];
}

function addFuzzyTokenScore(score: FuzzySubsequenceScore, tokenEditCost: number): FuzzySubsequenceScore | undefined {
  const editCost = score.editCost + tokenEditCost;
  if (editCost > SMART_FUZZY_TOTAL_EDIT_LIMIT) return undefined;
  return { editCost };
}

function betterFuzzySubsequenceScore(left: FuzzySubsequenceScore | undefined, right: FuzzySubsequenceScore | undefined): FuzzySubsequenceScore | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.editCost <= right.editCost ? left : right;
}

function fuzzyTokenEditCost(queryToken: string, targetToken: string): number | undefined {
  if (queryToken === targetToken) return 0;
  if (queryToken.length < SMART_FUZZY_MIN_TOKEN_LENGTH) return undefined;
  const maxEdits = queryToken.length >= SMART_FUZZY_TWO_EDIT_TOKEN_LENGTH ? 2 : 1;
  const editDistance = boundedDamerauLevenshteinDistance(queryToken, targetToken, maxEdits);
  return editDistance <= maxEdits ? editDistance : undefined;
}

function boundedDamerauLevenshteinDistance(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

  let previousPreviousRow = new Array<number>(right.length + 1).fill(maxDistance + 1);
  let previousRow = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const currentRow = new Array<number>(right.length + 1);
    currentRow[0] = leftIndex;
    let rowMinimum = currentRow[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      let distance = Math.min(
        previousRow[rightIndex] + 1,
        currentRow[rightIndex - 1] + 1,
        previousRow[rightIndex - 1] + substitutionCost
      );
      if (leftIndex > 1 && rightIndex > 1 && left[leftIndex - 1] === right[rightIndex - 2] && left[leftIndex - 2] === right[rightIndex - 1]) {
        distance = Math.min(distance, previousPreviousRow[rightIndex - 2] + 1);
      }
      currentRow[rightIndex] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    previousPreviousRow = previousRow;
    previousRow = currentRow;
  }
  return previousRow[right.length];
}

function combinedSelectorMatches(content: string, selector: NonNullable<MatchPatchOp["combinedSelector"]>): boolean {
  return (
    (selector.prefix === undefined || content.startsWith(selector.prefix)) &&
    (selector.contains === undefined || selector.contains.every((needle) => content.includes(needle))) &&
    (selector.suffix === undefined || content.endsWith(selector.suffix))
  );
}

function hasMatchSelector(op: MatchPatchOp): boolean {
  return op.hash !== undefined || op.content !== undefined || op.combinedSelector !== undefined;
}

function findHunkCandidatesOrThrow(
  entries: CurrentLineEntry[],
  hunk: Hunk,
  matchOps: readonly MatchPatchOp[],
  anchorMode: AnchorMode
): ResolvedHunkMatch[] {
  const candidates = anchorMode === "tolerant" && hunk.anchorHint
    ? findTolerantHunkCandidates(entries, hunk, matchOps)
    : findStrongestHunkCandidates(entries, hunk, matchOps, {
      start: getAnchorSearchStart(hunk),
      end: getAnchorSearchEnd(hunk)
    });
  if (candidates.length > 0) return candidates;

  if (anchorMode === "tolerant" && hunk.anchorHint) {
    throw new StaleHunkError("Hunk not found in any anchor affinity.", hunkErrorLocation(hunk));
  }
  const staleDetail = `Hunk not found${renderAnchorSearchScope(hunk)}.`;
  const diagnosticMatch = hunk.anchorHint
    ? findOutsideAnchorDiagnosticMatch(entries, hunk, matchOps)
    : undefined;
  if (diagnosticMatch) {
    throw new StaleHunkError(`${staleDetail} ${renderOutsideAnchorDiagnostic(diagnosticMatch.match)}`, hunkErrorLocation(hunk));
  }
  throw new StaleHunkError(staleDetail, hunkErrorLocation(hunk));
}

function findStrongestHunkCandidates(
  entries: CurrentLineEntry[],
  hunk: Hunk,
  matchOps: readonly MatchPatchOp[],
  search: HunkMatchSearch
): ResolvedHunkMatch[] {
  const candidates = findHunkCandidates(entries, hunk, matchOps, search);
  if (!hunkHasSmartSelector(hunk)) return candidates;
  return nonDominatedSmartCandidates(candidates, smartOpIndexes(hunk.ops));
}

function findHunkCandidates(
  entries: CurrentLineEntry[],
  hunk: Hunk,
  matchOps: readonly MatchPatchOp[],
  search: HunkMatchSearch
): ResolvedHunkMatch[] {
  const searchEnd = search.end ?? entries.length;
  const errorScope = search.errorScope ?? renderAnchorSearchScope(hunk);
  const matchFilter = search.matchFilter ?? (() => true);

  if (!hunkHasSmartSelector(hunk)) {
    const matches = hunkHasSparseRange(hunk)
      ? findSparseMatches(entries, hunk.ops, HUNK_CANDIDATE_LIMIT + 1, search.start, searchEnd, lineMatchesOp, matchFilter)
      : findContiguousMatches(entries, matchOps, search.start, searchEnd, lineMatchesOp, matchFilter, HUNK_CANDIDATE_LIMIT + 1)
        .map((start) => contiguousMatchToSparseMatch(hunk.ops, start));
    if (matches.length > HUNK_CANDIDATE_LIMIT) {
      throw new HunkCandidateLimitError(renderHunkCandidateLimitDetail(hunk, errorScope, matches), hunkErrorLocation(hunk));
    }
    return matches.map((match) => ({ match, smartMatcherKinds: new Map(), smartMatcherEditCosts: new Map() }));
  }

  const candidates = hunkHasSparseRange(hunk)
    ? findSparseSmartMatchCandidates(entries, hunk.ops, search.start, searchEnd, matchFilter)
    : findContiguousSmartMatchCandidates(entries, hunk.ops, search.start, searchEnd, matchFilter);
  if (candidates.length > HUNK_CANDIDATE_LIMIT) {
    throw new HunkCandidateLimitError(renderHunkCandidateLimitDetail(hunk, errorScope, candidates.map((candidate) => candidate.match)), hunkErrorLocation(hunk));
  }
  return candidates;
}

function findTolerantHunkCandidates(
  entries: CurrentLineEntry[],
  hunk: Hunk,
  matchOps: readonly MatchPatchOp[]
): ResolvedHunkMatch[] {
  const anchor = hunk.anchorHint;
  if (!anchor) return [];

  for (const affinity of ["contained", "overlapping", "outside"] as const) {
    // Anchor affinity is selected from the complete eligible class before
    // smart dominance can discard candidates or group solving can filter them.
    const eligibleCandidates = findHunkCandidates(entries, hunk, matchOps, anchorAffinitySearch(hunk, entries.length, affinity));
    if (eligibleCandidates.length === 0) continue;
    const candidates = hunkHasSmartSelector(hunk)
      ? nonDominatedSmartCandidates(eligibleCandidates, smartOpIndexes(hunk.ops))
      : eligibleCandidates;
    if (affinity === "contained") return candidates;
    return candidates.map((candidate) => ({
      ...candidate,
      anchorResolution: {
        affinity,
        authoredAnchor: {
          startLine: anchor.line,
          ...(anchor.endLine === undefined ? {} : { endLine: anchor.endLine })
        },
        resolvedMatch: { startLine: candidate.match.start + 1, endLine: candidate.match.end }
      }
    }));
  }
  return [];
}

function validateResolvedReplaceRows(
  sourceLines: readonly PatchLineState[],
  hunk: Hunk,
  hunkIndex: number,
  match: SparseMatch
): void {
  for (const [opIndex, op] of hunk.ops.entries()) {
    if (op.kind !== "context") continue;
    const replaceOps = followingReplaceOps(hunk.ops, opIndex);
    if (replaceOps.length === 0) continue;
    const sourceIndex = match.lineIndexes.get(opIndex);
    if (sourceIndex === undefined) throw new Error("Internal patch error: missing resolved context line.");
    applyLineReplaceOps(sourceLines[sourceIndex].content, replaceOps, hunkIndex, hunk);
  }
}

function validateResolvedHunkConflicts(hunks: readonly ResolvedSectionHunk[]): void {
  for (const [hunkOffset, hunk] of hunks.entries()) {
    const match = hunk.match?.match;
    if (!match) continue;
    for (let priorOffset = 0; priorOffset < hunkOffset; priorOffset += 1) {
      const prior = hunks[priorOffset];
      const priorMatch = prior.match?.match;
      if (priorMatch && priorMatch.start < match.end && match.start < priorMatch.end) {
        throw new ConflictingHunksError(
          `Resolved hunks ${prior.hunkIndex} and ${hunk.hunkIndex} overlap source spans ${priorMatch.start + 1}...${priorMatch.end} and ${match.start + 1}...${match.end} (${renderHunkInputLineRange(prior.hunk)}; ${renderHunkInputLineRange(hunk.hunk)}).`,
          hunkErrorLocation(hunk.hunk)
        );
      }
    }
  }
}

function materializeSourceMatch(
  sourceMatch: ResolvedHunkMatch,
  currentLines: readonly PatchLineState[],
  sourceLineCount: number
): ResolvedHunkMatch {
  const currentIndexBySourceIndex = new Map<number, number>();
  for (const [currentIndex, line] of currentLines.entries()) {
    if (line.sourceIndex !== undefined) currentIndexBySourceIndex.set(line.sourceIndex, currentIndex);
  }
  const currentIndexForSource = (sourceIndex: number) => {
    const currentIndex = currentIndexBySourceIndex.get(sourceIndex);
    if (currentIndex === undefined) throw new Error("Internal patch error: pre-resolved source line is unavailable.");
    return currentIndex;
  };
  const currentBoundaryForSource = (sourceIndex: number) =>
    sourceIndex === sourceLineCount ? currentLines.length : currentIndexForSource(sourceIndex);
  const match = sourceMatch.match;
  return {
    ...sourceMatch,
    match: {
      start: currentIndexForSource(match.start),
      // The source boundary after this span may have been deleted, or may have
      // prior inserted output before it. End after the span's final source line
      // so this hunk rewrites only its original lines and retains that output.
      end: currentIndexForSource(match.end - 1) + 1,
      lineIndexes: new Map(Array.from(match.lineIndexes, ([opIndex, sourceIndex]) => [opIndex, currentIndexForSource(sourceIndex)])),
      ranges: new Map(Array.from(match.ranges, ([opIndex, range]) => [
        opIndex,
        { start: currentBoundaryForSource(range.start), end: currentBoundaryForSource(range.end) }
      ]))
    }
  };
}

function anchorAffinitySearch(hunk: Hunk, lineCount: number, affinity: AnchorAffinity): HunkMatchSearch {
  const anchor = hunk.anchorHint;
  if (!anchor) throw new Error("Internal patch error: tolerant anchor resolution requires an anchor.");
  if (affinity === "contained") {
    return {
      start: anchor.line - 1,
      end: anchor.endLine ?? lineCount,
      errorScope: " in contained anchor affinity"
    };
  }
  return {
    start: 0,
    matchFilter: (match) => classifyAnchorAffinity(match, anchor, lineCount) === affinity,
    errorScope: ` in ${affinity} anchor affinity`
  };
}

function classifyAnchorAffinity(match: SparseMatch, anchor: NonNullable<Hunk["anchorHint"]>, lineCount: number): AnchorAffinity {
  const anchorStart = anchor.line - 1;
  const anchorEnd = anchor.endLine ?? lineCount;
  if (match.start >= anchorStart && match.end <= anchorEnd) return "contained";
  if (match.start < anchorEnd && match.end > anchorStart) return "overlapping";
  return "outside";
}

function hunkHasSmartSelector(hunk: Hunk): boolean {
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

function findOutsideAnchorDiagnosticMatch(
  entries: CurrentLineEntry[],
  hunk: Hunk,
  matchOps: readonly MatchPatchOp[]
): ResolvedHunkMatch | undefined {
  // This is diagnostic-only: never let whole-file candidate volume change a
  // stale strict-anchor failure into a candidate-limit failure.
  const diagnosticMatch = hunkHasSmartSelector(hunk)
    ? findBoundedSmartDiagnosticMatch(entries, hunk)
    : findBoundedFixedDiagnosticMatch(entries, hunk, matchOps);
  if (!diagnosticMatch || !hunk.anchorHint) return undefined;
  const match = diagnosticMatch.match;
  const startsBeforeAnchor = match.start < hunk.anchorHint.line - 1;
  const endsAfterAnchor = hunk.anchorHint.endLine !== undefined && match.end > hunk.anchorHint.endLine;
  return startsBeforeAnchor || endsAfterAnchor ? diagnosticMatch : undefined;
}

function findBoundedFixedDiagnosticMatch(
  entries: CurrentLineEntry[],
  hunk: Hunk,
  matchOps: readonly MatchPatchOp[]
): ResolvedHunkMatch | undefined {
  const matches = hunkHasSparseRange(hunk)
    ? findSparseMatches(entries, hunk.ops, 2, 0, entries.length)
    : findContiguousMatches(entries, matchOps, 0, entries.length, lineMatchesOp, () => true, 2)
      .map((start) => contiguousMatchToSparseMatch(hunk.ops, start));
  return matches.length === 1
    ? { match: matches[0], smartMatcherKinds: new Map(), smartMatcherEditCosts: new Map() }
    : undefined;
}

function findBoundedSmartDiagnosticMatch(
  entries: CurrentLineEntry[],
  hunk: Hunk
): ResolvedHunkMatch | undefined {
  try {
    const candidates = findStrongestHunkCandidates(entries, hunk, hunk.ops.filter(isMatchOp), { start: 0 });
    return candidates.length === 1 ? candidates[0] : undefined;
  } catch (error) {
    // Optional guidance must not expose an oversized whole-file search as a
    // real resolution failure.
    if (error instanceof HunkCandidateLimitError) return undefined;
    throw error;
  }
}

function renderOutsideAnchorDiagnostic(match: SparseMatch): string {
  const firstLine = match.start + 1;
  return match.end - match.start === 1
    ? `Unique match exists outside line anchor at line ${firstLine}.`
    : `Unique match exists outside line anchor at lines ${firstLine}...${match.end}.`;
}

function buildMatchPattern(hunk: Hunk): string[] {
  return hunk.ops.flatMap((op) => {
    if (op.kind === "insert" || op.kind === "replace") return [];
    if (op.kind === "range") return [renderRangeSelector(op.rangeKind)];
    return [renderMatchSelector(op)];
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
    if (op.kind === "insert" || op.kind === "replace") return [];
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

function renderRangeSelector(rangeKind: "context" | "delete"): string {
  return `${rangeKind === "context" ? " " : "-"}...`;
}

function followingReplaceOps(ops: readonly Hunk["ops"][number][], contextOpIndex: number): ReplacePatchOp[] {
  const replaceOps: ReplacePatchOp[] = [];
  for (let index = contextOpIndex + 1; index < ops.length; index += 1) {
    const op = ops[index];
    if (op.kind !== "replace") break;
    replaceOps.push(op);
  }
  return replaceOps;
}

function applyLineReplaceOps(content: string, replaceOps: readonly ReplacePatchOp[], hunkIndex: number, hunk: Hunk): string {
  let current = content;
  for (const replaceOp of replaceOps) {
    const occurrenceCount = countOccurrences(current, replaceOp.oldText);
    if (occurrenceCount === 0) {
      throw new StaleHunkError(`Hunk ${hunkIndex} replace text not found in selected line.`, patchErrorLocation(replaceOp, hunk));
    }
    if (occurrenceCount > 1) {
      throw new AmbiguousHunkError(`Hunk ${hunkIndex} replace text matched ${occurrenceCount} occurrences in selected line.`, patchErrorLocation(replaceOp, hunk));
    }
    current = current.replace(replaceOp.oldText, replaceOp.newText);
  }
  return current;
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = content.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += 1;
  }
}

function replaceOpAuthoredCharFallback(op: ReplacePatchOp): number {
  return op.oldText.length + op.newText.length + 2;
}

function authoredHunkLineCount(hunk: Hunk): number {
  return hunk.ops.reduce((total, op) => total + (op.kind === "replace" ? 2 : 1), 0);
}

function renderMatchSelector(op: MatchPatchOp): string {
  if (!hasMatchSelector(op)) return "<missing selector>";
  if (op.hash !== undefined && (op.content !== undefined || op.combinedSelector !== undefined)) return "<invalid hash+text selector>";
  if (op.content !== undefined && op.combinedSelector !== undefined) return "<invalid mixed text selector>";
  if (op.hash !== undefined) return `${op.kind === "context" ? " #" : "-#"}${op.hash}`;
  if (op.combinedSelector !== undefined) return `${op.kind === "context" ? " ?" : "-?"}${JSON.stringify(op.combinedSelector)}`;
  if (op.smart === true) return `${op.kind === "context" ? " ~" : "-~"}${op.content ?? ""}`;
  const prefix = op.kind === "context" ? " :" : "-:";
  if (op.textSelector === "prefix") return `${op.kind === "context" ? " ^" : "-^"}${op.content ?? ""}`;
  if (op.textSelector === "contains") return `${op.kind === "context" ? " *" : "-*"}${op.content ?? ""}`;
  if (op.textSelector === "suffix") return `${op.kind === "context" ? " $" : "-$"}${op.content ?? ""}`;
  return `${prefix}${op.content ?? ""}`;
}

function unifiedDiffLineCharCount(kind: "context" | "delete" | "insert", content: string): number {
  if (kind === "context" && content.length === 0) return 0;
  return content.length + 1;
}

function authoredCharCount(op: Hunk["ops"][number], fallback: number): number {
  return op.authoredCharCount ?? fallback;
}

function rangeCharCount(lines: readonly PatchLineState[], start: number, end: number, kind: "context" | "delete"): number {
  let total = 0;
  for (let index = start; index < end; index += 1) {
    total += unifiedDiffLineCharCount(kind, lines[index].content);
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

function validateReplaceRows(hunk: Hunk, hunkIndex: number): void {
  let hasReplaceTarget = false;
  for (const op of hunk.ops) {
    if (op.kind === "context") {
      hasReplaceTarget = true;
      continue;
    }
    if (op.kind === "replace") {
      if (!hasReplaceTarget) {
        throw new UnsupportedHunkError(`Hunk ${hunkIndex} replace row must follow a context selector.`, patchErrorLocation(op, hunk));
      }
      continue;
    }
    hasReplaceTarget = false;
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

function validateNoConflictingSelectors(hunk: Hunk, hunkIndex: number): void {
  for (const op of hunk.ops) {
    if (isMatchOp(op) && op.smart === true && op.content === undefined) {
      throw new InvalidPatchError(`Hunk ${hunkIndex} smart selectors require text content.`, patchErrorLocation(op, hunk));
    }
    if (isMatchOp(op) && op.hash !== undefined && (op.content !== undefined || op.combinedSelector !== undefined)) {
      throw new InvalidPatchError(`Hunk ${hunkIndex} hash+text selectors are not supported. Use hash-only or text-only selector.`, patchErrorLocation(op, hunk));
    }
    if (isMatchOp(op) && op.content !== undefined && op.combinedSelector !== undefined) {
      throw new InvalidPatchError(`Hunk ${hunkIndex} mixed text selectors are not supported. Use exactly one text selector form.`, patchErrorLocation(op, hunk));
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

function findContiguousSmartMatchCandidates(entries: CurrentLineEntry[], ops: readonly Hunk["ops"][number][], searchStart = 0, searchEnd = entries.length, matchFilter: (match: SparseMatch) => boolean = () => true): SmartHunkCandidate[] {
  const candidates: SmartHunkCandidate[] = [];
  const matchOpCount = ops.filter(isMatchOp).length;
  const lastStart = Math.min(entries.length - matchOpCount, searchEnd - matchOpCount);
  for (let start = searchStart; start <= lastStart; start += 1) {
    const candidate = contiguousSmartMatchCandidateAt(entries, ops, start);
    if (!candidate || !matchFilter(candidate.match)) continue;
    candidates.push(candidate);
    if (candidates.length > HUNK_CANDIDATE_LIMIT) break;
  }
  return candidates;
}

function contiguousSmartMatchCandidateAt(entries: readonly CurrentLineEntry[], ops: readonly Hunk["ops"][number][], start: number): SmartHunkCandidate | undefined {
  const lineIndexes = new Map<number, number>();
  const smartMatcherKinds = new Map<number, PatchMatcherKind>();
  const smartMatcherEditCosts = new Map<number, number>();
  let consumed = 0;
  for (const [opIndex, op] of ops.entries()) {
    if (!isMatchOp(op)) continue;
    const targetIndex = start + consumed;
    const lineMatch = matchSmartCandidateLine(entries[targetIndex], op);
    if (lineMatch === undefined) return undefined;
    lineIndexes.set(opIndex, targetIndex);
    if (op.smart === true) {
      smartMatcherKinds.set(opIndex, lineMatch.kind);
      smartMatcherEditCosts.set(opIndex, lineMatch.editCost);
    }
    consumed += 1;
  }
  return {
    match: { start, end: start + consumed, lineIndexes, ranges: new Map() },
    smartMatcherKinds,
    smartMatcherEditCosts
  };
}

function findSparseSmartMatchCandidates(entries: CurrentLineEntry[], ops: readonly Hunk["ops"][number][], searchStart = 0, searchEnd = entries.length, matchFilter: (match: SparseMatch) => boolean = () => true): SmartHunkCandidate[] {
  const candidates: SmartHunkCandidate[] = [];
  for (let start = searchStart; start <= entries.length && start <= searchEnd && candidates.length <= HUNK_CANDIDATE_LIMIT; start += 1) {
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
      smartMatcherEditCosts: new Map(),
      candidates,
      matchFilter
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
  smartMatcherEditCosts: Map<number, number>;
  candidates: SmartHunkCandidate[];
  matchFilter: (match: SparseMatch) => boolean;
}): void {
  if (state.candidates.length > HUNK_CANDIDATE_LIMIT) return;
  const opIndex = nextMatchOpIndex(state.ops, state.opIndex);
  if (opIndex === undefined) {
    const match = { start: state.start, end: state.position, lineIndexes: state.lineIndexes, ranges: state.ranges };
    if (state.position <= state.searchEnd && state.matchFilter(match)) {
      state.candidates.push({
        match,
        smartMatcherKinds: state.smartMatcherKinds,
        smartMatcherEditCosts: state.smartMatcherEditCosts
      });
    }
    return;
  }

  const op = state.ops[opIndex];
  if (isMatchOp(op)) {
    if (state.position >= state.searchEnd) return;
    const lineMatch = matchSmartCandidateLine(state.entries[state.position], op);
    if (lineMatch === undefined) return;
    const lineIndexes = new Map(state.lineIndexes);
    lineIndexes.set(opIndex, state.position);
    const smartMatcherKinds = op.smart === true ? new Map(state.smartMatcherKinds).set(opIndex, lineMatch.kind) : state.smartMatcherKinds;
    const smartMatcherEditCosts = op.smart === true ? new Map(state.smartMatcherEditCosts).set(opIndex, lineMatch.editCost) : state.smartMatcherEditCosts;
    collectSparseSmartMatchCandidates({ ...state, opIndex: opIndex + 1, position: state.position + 1, lineIndexes, smartMatcherKinds, smartMatcherEditCosts });
    return;
  }

  for (let end = state.position; end <= state.entries.length && end <= state.searchEnd && state.candidates.length <= HUNK_CANDIDATE_LIMIT; end += 1) {
    if (!rangeIsAvailableForHunkMatch(state.entries, state.position, end)) continue;
    const ranges = new Map(state.ranges);
    ranges.set(opIndex, { start: state.position, end });
    collectSparseSmartMatchCandidates({ ...state, opIndex: opIndex + 1, position: end, ranges });
  }
}

function matchSmartCandidateLine(line: CurrentLineEntry | undefined, op: MatchPatchOp): { kind: PatchMatcherKind; editCost: number } | undefined {
  if (!line || !line.availableForHunkMatch || !hasMatchSelector(op)) return undefined;
  if (op.hash !== undefined && op.hash !== line.hash.slice(0, op.hash.length)) return undefined;
  if (op.smart !== true) return textSelectorMatches(line.content, op) ? { kind: "exact", editCost: 0 } : undefined;
  if (op.content === undefined) return undefined;
  return bestSmartMatcherResult(op.content, line.content);
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
    const leftEditCost = left.smartMatcherEditCosts.get(opIndex) ?? 0;
    const rightEditCost = right.smartMatcherEditCosts.get(opIndex) ?? 0;
    if (leftEditCost > rightEditCost) return false;
    if (leftEditCost < rightEditCost) hasBetterRow = true;
  }
  return hasBetterRow;
}

function smartMatcherRank(kind: PatchMatcherKind | undefined): number {
  if (kind === "exact" || kind === "prefix" || kind === "suffix" || kind === "contains" || kind === "subsequence" || kind === "fuzzy" || kind === "charSubsequence") {
    return SMART_MATCH_RANKS[kind];
  }
  throw new Error("Internal patch error: missing smart matcher kind.");
}

function findSparseMatches(entries: CurrentLineEntry[], ops: readonly Hunk["ops"][number][], maxMatches: number, searchStart = 0, searchEnd = entries.length, lineMatcher: LineMatcher = lineMatchesOp, matchFilter: (match: SparseMatch) => boolean = () => true): SparseMatch[] {
  const matches: SparseMatch[] = [];
  for (let start = searchStart; start <= entries.length && start <= searchEnd && matches.length < maxMatches; start += 1) {
    collectSparseMatches({ entries, ops, opIndex: 0, position: start, start, searchEnd, lineIndexes: new Map(), ranges: new Map(), matches, maxMatches, lineMatcher, matchFilter });
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
  matchFilter: (match: SparseMatch) => boolean;
}): void {
  if (state.matches.length >= state.maxMatches) return;
  const opIndex = nextMatchOpIndex(state.ops, state.opIndex);
  if (opIndex === undefined) {
    const match = { start: state.start, end: state.position, lineIndexes: state.lineIndexes, ranges: state.ranges };
    if (state.position <= state.searchEnd && state.matchFilter(match)) {
      state.matches.push(match);
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
    if (ops[index].kind !== "insert" && ops[index].kind !== "replace") return index;
  }
  return undefined;
}

function renderSkippedContextRange(lineCount: number): string {
  return lineCount === 0 ? "..." : `... ${lineCount} skipped context line${lineCount === 1 ? "" : "s"}`;
}

function findContiguousMatches(entries: CurrentLineEntry[], sequence: readonly MatchPatchOp[], searchStart = 0, searchEnd = entries.length, lineMatcher: LineMatcher = lineMatchesOp, matchFilter: (match: SparseMatch) => boolean = () => true, maxMatches = 2): number[] {
  const matches: number[] = [];
  const lastStart = Math.min(entries.length - sequence.length, searchEnd - sequence.length);
  for (let index = searchStart; index <= lastStart; index += 1) {
    if (sequence.every((op, offset) => lineMatcher(entries[index + offset], op)) && matchFilter(contiguousMatchToSparseMatch(sequence, index))) {
      matches.push(index);
      if (matches.length >= maxMatches) break;
    }
  }
  return matches;
}
