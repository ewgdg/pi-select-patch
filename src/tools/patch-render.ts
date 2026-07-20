import type { Theme } from "@earendil-works/pi-coding-agent";
import { type PatchSizeComparison } from "../patch-size.js";
import { type SelectorEfficiency } from "../selector-efficiency.js";
import { firstLine, isRecord } from "../value.js";

export const COLLAPSED_RESULT_DIFF_MAX_LINES = 16;
export const EXPANDED_RESULT_DIFF_MAX_LINES = 200;
export const COLLAPSED_ERROR_INPUT_MAX_LINES = 16;
export const EXPANDED_ERROR_INPUT_MAX_LINES = 200;
export const COLLAPSED_ERROR_INPUT_CONTEXT_RADIUS = 4;
export const EXPANDED_ERROR_INPUT_CONTEXT_RADIUS = 20;
export const COLLAPSED_STREAMING_INPUT_MAX_LINES = 16;
export const EXPANDED_STREAMING_INPUT_MAX_LINES = 200;

export type PatchRenderTheme = Pick<Theme, "fg">;

export interface PatchDiffStats {
  additions: number;
  removals: number;
  totalLines: number;
}

export interface PatchMatcherStats {
  exact: number;
  prefix: number;
  contains: number;
  suffix: number;
  subsequence: number;
  fuzzy: number;
  charSubsequence: number;
  hash: number;
  combined: number;
  range: number;
  unifiedDiff: number;
  total: number;
}

export interface FormattedPatchResultDiff {
  text: string;
  omittedLineCount: number;
  shownLineCount: number;
  totalLineCount: number;
}

export function getPatchResultText(result: { content?: Array<{ type: string; text?: string }> }): string | undefined {
  const textContent = result.content?.find(
    (entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string"
  );
  return textContent?.text;
}

export function getPatchResultDiff(details: unknown): string | undefined {
  if (!isRecord(details) || typeof details.diff !== "string" || details.diff.length === 0) {
    return undefined;
  }
  return details.diff;
}

export function getPatchDiffStats(diff: string): PatchDiffStats {
  let additions = 0;
  let removals = 0;
  const lines = splitDiffLines(diff);
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
  }
  return { additions, removals, totalLines: lines.length };
}

export function getPatchMatcherStats(details: unknown): PatchMatcherStats {
  const stats = createEmptyPatchMatcherStats();
  if (!isRecord(details) || !Array.isArray(details.files)) {
    return stats;
  }

  for (const file of details.files) {
    if (!isRecord(file) || !isRecord(file.audit) || !Array.isArray(file.audit.hunkAudits)) {
      continue;
    }
    for (const hunkAudit of file.audit.hunkAudits) {
      if (!isRecord(hunkAudit)) {
        continue;
      }
      if (Array.isArray(hunkAudit.matcherKinds)) {
        for (const matcherKind of hunkAudit.matcherKinds) {
          if (typeof matcherKind === "string") {
            incrementPatchMatcherKind(stats, matcherKind);
          }
        }
        continue;
      }
      if (!Array.isArray(hunkAudit.matchPattern)) {
        continue;
      }
      for (const matchPattern of hunkAudit.matchPattern) {
        if (typeof matchPattern !== "string") {
          continue;
        }
        incrementPatchMatcherStats(stats, matchPattern);
      }
    }
  }

  return stats;
}

export function getPatchSize(details: unknown): PatchSizeComparison | undefined {
  if (!isRecord(details) || !isRecord(details.patchSize)) {
    return undefined;
  }
  const { patchChars, unifiedDiffChars } = details.patchSize;
  if (!isNonNegativeInteger(patchChars) || !isNonNegativeInteger(unifiedDiffChars)) {
    return undefined;
  }
  return { patchChars, unifiedDiffChars };
}

export function getPatchSelectorEfficiency(details: unknown): SelectorEfficiency | undefined {
  if (!isRecord(details) || !isRecord(details.selectorEfficiency)) {
    return undefined;
  }
  const { patchChars, baselineChars } = details.selectorEfficiency;
  if (!isNonNegativeInteger(patchChars) || !isNonNegativeInteger(baselineChars)) {
    return undefined;
  }
  return { patchChars, baselineChars };
}

export function formatPatchResultDiff(diff: string, expanded: boolean, theme: PatchRenderTheme): FormattedPatchResultDiff {
  const lines = splitDiffLines(diff);
  const maxLines = expanded ? EXPANDED_RESULT_DIFF_MAX_LINES : COLLAPSED_RESULT_DIFF_MAX_LINES;
  const shownLines = lines.slice(0, maxLines);
  const omittedLineCount = Math.max(0, lines.length - shownLines.length);
  const renderedLines = colorPatchDiffLines(shownLines, theme);

  if (omittedLineCount > 0) {
    const suffix = expanded ? "omitted" : "omitted; Ctrl+O to expand";
    renderedLines.push(theme.fg("muted", `... ${omittedLineCount} more diff lines ${suffix}`));
  }

  return {
    text: renderedLines.join("\n"),
    omittedLineCount,
    shownLineCount: shownLines.length,
    totalLineCount: lines.length
  };
}

export function colorPatchDiffLines(lines: readonly string[], theme: PatchRenderTheme): string[] {
  return lines.map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return theme.fg("toolDiffAdded", line);
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return theme.fg("toolDiffRemoved", line);
    }
    return theme.fg("toolDiffContext", line);
  });
}

export function formatPatchErrorInputPreview(input: unknown, expanded: boolean, theme: PatchRenderTheme, errorText?: string): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  if (typeof input.patch === "string") {
    return formatPatchTextPreview("patch", input.patch, expanded, theme, getErrorInputLine(errorText));
  }

  if (typeof input.patch_file === "string") {
    return [
      theme.fg("muted", "Agent input:"),
      `${theme.fg("dim", "patch_file: ")}${theme.fg("toolDiffContext", input.patch_file)}`
    ].join("\n");
  }

  return undefined;
}

export function buildPatchCallRenderText(options: {
  input: unknown;
  expanded: boolean;
  argsComplete: boolean;
  theme: PatchRenderTheme;
}): string {
  const { input, expanded, argsComplete, theme } = options;
  const title = theme.fg("toolTitle", "edit");

  if (argsComplete) {
    return formatPatchCallHeader(input, title, theme);
  }

  const preview = formatPatchStreamingInputPreview(input, expanded, theme);
  if (!preview) {
    return [title, theme.fg("muted", "Agent input streaming...")].join("\n");
  }

  return [title, preview].join("\n");
}

export function formatPatchStreamingInputPreview(input: unknown, expanded: boolean, theme: PatchRenderTheme): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  if (typeof input.patch === "string") {
    return formatPatchStreamingTextPreview("patch", input.patch, expanded, theme);
  }

  if (typeof input.patch_file === "string") {
    return [
      theme.fg("muted", "Agent input streaming:"),
      `${theme.fg("dim", "patch_file: ")}${theme.fg("toolDiffContext", input.patch_file)}`
    ].join("\n");
  }

  return undefined;
}

export function buildPatchResultRenderText(options: {
  resultText?: string;
  details: unknown;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
  errorInput?: unknown;
  theme: PatchRenderTheme;
}): string {
  const { resultText, details, expanded, isPartial, isError, errorInput, theme } = options;
  if (isPartial) {
    return theme.fg("warning", "Applying edit...");
  }

  if (isError) {
    const errorText = formatPatchErrorResultText(resultText);
    const preview = formatPatchErrorInputPreview(errorInput, expanded, theme, errorText);
    return [theme.fg("error", errorText), preview].filter((part): part is string => Boolean(part)).join("\n");
  }

  const diff = getPatchResultDiff(details);
  if (!diff) {
    return theme.fg("success", firstLine(resultText) ?? "Edit completed");
  }

  const stats = getPatchDiffStats(diff);
  const dryRun = isRecord(details) && details.dryRun === true;
  const summaryParts = [
    dryRun ? "Edit dry-run succeeded" : "Edit applied",
    theme.fg("toolDiffAdded", `+${stats.additions}`),
    theme.fg("toolDiffRemoved", `-${stats.removals}`),
  ];
  const renderedDiff = formatPatchResultDiff(diff, expanded, theme);
  const matcherStatsFooter = formatPatchMatcherStatsFooter(getPatchMatcherStats(details), theme);
  const patchSizeFooter = formatPatchSizeFooter(getPatchSize(details), theme);
  const body = [`${theme.fg("success", summaryParts[0])} ${summaryParts.slice(1).join(theme.fg("dim", " / "))}`, renderedDiff.text, matcherStatsFooter, patchSizeFooter];

  return body.filter((part): part is string => Boolean(part)).join("\n");
}

function createEmptyPatchMatcherStats(): PatchMatcherStats {
  return { exact: 0, prefix: 0, contains: 0, suffix: 0, subsequence: 0, fuzzy: 0, charSubsequence: 0, hash: 0, combined: 0, range: 0, unifiedDiff: 0, total: 0 };
}

function incrementPatchMatcherKind(stats: PatchMatcherStats, matcherKind: string): void {
  if (matcherKind === "exact") stats.exact += 1;
  else if (matcherKind === "prefix") stats.prefix += 1;
  else if (matcherKind === "contains") stats.contains += 1;
  else if (matcherKind === "suffix") stats.suffix += 1;
  else if (matcherKind === "subsequence") stats.subsequence += 1;
  else if (matcherKind === "fuzzy") stats.fuzzy += 1;
  else if (matcherKind === "charSubsequence") stats.charSubsequence += 1;
  else if (matcherKind === "hash") stats.hash += 1;
  else if (matcherKind === "combined") stats.combined += 1;
  else if (matcherKind === "range") stats.range += 1;
  else if (matcherKind === "unifiedDiff") stats.unifiedDiff += 1;
  else return;
  stats.total += 1;
}

function incrementPatchMatcherStats(stats: PatchMatcherStats, matchPattern: string): void {
  const selector = matchPattern.startsWith(" ") || matchPattern.startsWith("-") ? matchPattern.slice(1) : matchPattern;
  if (selector === "...") {
    stats.range += 1;
  } else if (selector.startsWith(":")) {
    stats.exact += 1;
  } else if (selector.startsWith("^")) {
    stats.prefix += 1;
  } else if (selector.startsWith("*")) {
    stats.contains += 1;
  } else if (selector.startsWith("$")) {
    stats.suffix += 1;
  } else if (selector.startsWith("~")) {
    stats.exact += 1;
  } else if (selector.startsWith("#")) {
    stats.hash += 1;
  } else if (selector.startsWith("?")) {
    stats.combined += 1;
  } else {
    return;
  }
  stats.total += 1;
}

function formatPatchMatcherStatsFooter(stats: PatchMatcherStats, theme: PatchRenderTheme): string | undefined {
  if (stats.total === 0) {
    return undefined;
  }

  const entries: Array<[string, number]> = [
    ["exact", stats.exact],
    ["prefix", stats.prefix],
    ["contains", stats.contains],
    ["suffix", stats.suffix],
    ["subsequence", stats.subsequence],
    ["fuzzy", stats.fuzzy],
    ["char-subsequence", stats.charSubsequence],
    ["hash", stats.hash],
    ["combined", stats.combined],
    ["range", stats.range],
    ["unified-diff", stats.unifiedDiff]
  ];
  const parts = entries
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count}`);

  return theme.fg("muted", `Matchers: ${parts.join(" / ")}`);
}

function formatPatchSizeFooter(size: PatchSizeComparison | undefined, theme: PatchRenderTheme): string | undefined {
  if (!size || size.unifiedDiffChars === 0) {
    return undefined;
  }
  const difference = size.patchChars - size.unifiedDiffChars;
  const relation = difference === 0
    ? "same as unified diff"
    : `${formatPercent((Math.abs(difference) / size.unifiedDiffChars) * 100)} ${difference < 0 ? "smaller" : "larger"} than unified diff`;
  return theme.fg("muted", `Patch size: ${size.patchChars} vs ${size.unifiedDiffChars} chars (${relation})`);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatPatchTextPreview(label: string, text: string, expanded: boolean, theme: PatchRenderTheme, targetLine?: number): string {
  const lines = splitInputLines(text);
  if (targetLine !== undefined && targetLine >= 1 && targetLine <= lines.length) {
    return formatPatchTextWindow(label, lines, expanded, theme, targetLine);
  }

  const maxLines = expanded ? EXPANDED_ERROR_INPUT_MAX_LINES : COLLAPSED_ERROR_INPUT_MAX_LINES;
  const shownLines = lines.slice(0, maxLines);
  const omittedLineCount = Math.max(0, lines.length - shownLines.length);
  const renderedLines = renderNumberedPatchLines(shownLines, 1, lines.length, theme);

  if (omittedLineCount > 0) {
    const suffix = expanded ? "omitted" : "omitted; Ctrl+O to expand";
    renderedLines.push(theme.fg("muted", `... ${omittedLineCount} more input lines ${suffix}`));
  }

  const countSummary = lines.length === shownLines.length ? `${lines.length} lines` : `${shownLines.length}/${lines.length} lines`;
  return [theme.fg("muted", `Agent input preview (${label}, ${countSummary}):`), ...renderedLines].join("\n");
}

function formatPatchStreamingTextPreview(label: string, text: string, expanded: boolean, theme: PatchRenderTheme): string {
  const lines = splitInputLines(text);
  const maxLines = expanded ? EXPANDED_STREAMING_INPUT_MAX_LINES : COLLAPSED_STREAMING_INPUT_MAX_LINES;
  const shownLines = lines.slice(-maxLines);
  const omittedLineCount = Math.max(0, lines.length - shownLines.length);
  const startLine = omittedLineCount + 1;
  const renderedLines = renderNumberedPatchLines(shownLines, startLine, lines.length, theme);

  if (omittedLineCount > 0) {
    const suffix = expanded ? "omitted" : "omitted; Ctrl+O to expand";
    renderedLines.unshift(theme.fg("muted", `... ${omittedLineCount} earlier input lines ${suffix}`));
  }

  const countSummary = lines.length === shownLines.length ? `${lines.length} lines` : `last ${shownLines.length}/${lines.length} lines`;
  return [theme.fg("muted", `Agent input streaming (${label}, ${countSummary}):`), ...renderedLines].join("\n");
}

function formatPatchCallHeader(input: unknown, title: string, theme: PatchRenderTheme): string {
  if (!isRecord(input)) {
    return title;
  }

  const suffixes: string[] = [];
  if (input.dry_run === true) {
    suffixes.push(theme.fg("muted", "dry-run"));
  }
  if (typeof input.patch_file === "string") {
    suffixes.push(theme.fg("dim", input.patch_file));
  }

  return [title, ...suffixes].join(" ");
}

function formatPatchTextWindow(label: string, lines: readonly string[], expanded: boolean, theme: PatchRenderTheme, targetLine: number): string {
  const radius = expanded ? EXPANDED_ERROR_INPUT_CONTEXT_RADIUS : COLLAPSED_ERROR_INPUT_CONTEXT_RADIUS;
  const startLine = Math.max(1, targetLine - radius);
  const endLine = Math.min(lines.length, targetLine + radius);
  const shownLines = lines.slice(startLine - 1, endLine);
  const renderedLines = renderNumberedPatchLines(shownLines, startLine, lines.length, theme, targetLine);

  if (startLine > 1) {
    renderedLines.unshift(theme.fg("muted", `... ${startLine - 1} earlier input lines omitted`));
  }
  if (endLine < lines.length) {
    renderedLines.push(theme.fg("muted", `... ${lines.length - endLine} later input lines omitted`));
  }

  return [theme.fg("muted", `Agent input around line ${targetLine} (${label}, lines ${startLine}-${endLine} of ${lines.length}):`), ...renderedLines].join("\n");
}

function renderNumberedPatchLines(lines: readonly string[], startLine: number, totalLineCount: number, theme: PatchRenderTheme, targetLine?: number): string[] {
  const numberWidth = String(Math.max(totalLineCount, 1)).length;
  return colorPatchDiffLines(lines, theme).map((line, index) => {
    const actualLine = startLine + index;
    const lineNumber = String(actualLine).padStart(numberWidth, " ");
    const lineNumberTheme = actualLine === targetLine ? "error" : "dim";
    return `${theme.fg(lineNumberTheme, `${lineNumber} │ `)}${line}`;
  });
}

function getErrorInputLine(errorText: string | undefined): number | undefined {
  const match = /^\[[A-Z0-9_]+\] Line ([1-9]\d*):/.exec(errorText ?? "");
  return match ? Number(match[1]) : undefined;
}

function splitDiffLines(diff: string): string[] {
  return diff.split("\n");
}

function splitInputLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function formatPatchErrorResultText(resultText: string | undefined): string {
  if (!resultText?.startsWith("[E_PARTIAL_PATCH]")) {
    return firstLine(resultText) ?? "Edit failed";
  }

  const lines = resultText.split("\n");
  const failedSection = extractPatchErrorSection(lines, "Failed:", ["Skipped:", "Retry patch:"]);
  const retryPatchLine = lines.find((line) => line.startsWith("Retry patch"));
  return [lines[0], failedSection, retryPatchLine].filter((part): part is string => Boolean(part)).join("\n");
}

function extractPatchErrorSection(lines: readonly string[], startMarker: string, endMarkers: readonly string[]): string | undefined {
  const startIndex = lines.indexOf(startMarker);
  if (startIndex === -1) {
    return undefined;
  }
  const endIndex = lines.findIndex((line, index) => index > startIndex && endMarkers.includes(line));
  return lines.slice(startIndex, endIndex === -1 ? undefined : endIndex).join("\n");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
