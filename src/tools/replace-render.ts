import type { Theme } from "@earendil-works/pi-coding-agent";
import { firstLine, isRecord } from "../value.js";
import { colorPatchDiffLines, getPatchResultDiff } from "./patch-render.js";

export const COLLAPSED_REPLACE_PREVIEW_MAX_LINES = 8;
export const EXPANDED_REPLACE_PREVIEW_MAX_LINES = 80;
export const COLLAPSED_REPLACE_PREVIEW_MAX_CHARS_PER_LINE = 240;
export const EXPANDED_REPLACE_PREVIEW_MAX_CHARS_PER_LINE = 2_000;
export const COLLAPSED_REPLACE_DIFF_MAX_LINES = 16;
export const EXPANDED_REPLACE_DIFF_MAX_LINES = 200;
const COLLAPSED_REPLACE_DIFF_MAX_CHARS_PER_LINE = 500;
const EXPANDED_REPLACE_DIFF_MAX_CHARS_PER_LINE = 2_000;

export type ReplaceRenderTheme = Pick<Theme, "fg">;

interface ReplaceRenderInput {
  file_path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

export function buildReplaceCallRenderText(options: {
  input: unknown;
  expanded: boolean;
  theme: ReplaceRenderTheme;
}): string {
  const { input, expanded, theme } = options;
  const args = isRecord(input) ? input as ReplaceRenderInput : undefined;
  const path = typeof args?.file_path === "string" ? args.file_path : "";
  const header = [theme.fg("toolTitle", "replace"), path].filter(Boolean).join(" ");
  const preview = formatReplaceInputPreview(input, expanded, theme);

  if (preview) return `${header}\n${preview}`;
  return `${header}\n${theme.fg("muted", "Agent input streaming...")}`;
}

export function formatReplaceInputPreview(
  input: unknown,
  expanded: boolean,
  theme: ReplaceRenderTheme,
): string | undefined {
  if (!isRecord(input)) return undefined;
  const args = input as ReplaceRenderInput;
  const sections: string[] = [];

  if (typeof args.old_string === "string") {
    sections.push(formatLabelledValue("old_string", args.old_string, expanded, theme));
  }
  if (typeof args.new_string === "string") {
    sections.push(formatLabelledValue("new_string", args.new_string, expanded, theme));
  }
  if (args.replace_all === true) {
    sections.push(theme.fg("warning", "replace_all: true"));
  }

  return sections.length > 0 ? sections.join("\n") : undefined;
}

export function buildReplaceResultRenderText(options: {
  resultText?: string;
  details: unknown;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
  errorInput?: unknown;
  theme: ReplaceRenderTheme;
}): string {
  const {
    resultText,
    details,
    expanded,
    isPartial,
    isError,
    errorInput,
    theme,
  } = options;

  if (isPartial) return theme.fg("warning", "Replacing...");

  if (isError) {
    const errorLine = firstLine(resultText) ?? "Replace failed";
    const preview = formatReplaceInputPreview(errorInput, expanded, theme);
    return [theme.fg("error", errorLine), preview]
      .filter((part): part is string => Boolean(part))
      .join("\n");
  }

  const receipt = firstLine(resultText) ?? "Replace completed";
  const diff = getPatchResultDiff(details);
  if (!diff) return theme.fg("success", receipt);
  return [
    theme.fg("success", receipt),
    formatReplaceDiff(diff, expanded, theme),
  ].join("\n");
}

function formatLabelledValue(
  label: "old_string" | "new_string",
  value: string,
  expanded: boolean,
  theme: ReplaceRenderTheme,
): string {
  const labelText = theme.fg("dim", `${label}:`);
  if (value.length === 0) {
    return `${labelText} ${theme.fg("muted", "(empty)")}`;
  }

  const maxLines = expanded
    ? EXPANDED_REPLACE_PREVIEW_MAX_LINES
    : COLLAPSED_REPLACE_PREVIEW_MAX_LINES;
  const maxCharactersPerLine = expanded
    ? EXPANDED_REPLACE_PREVIEW_MAX_CHARS_PER_LINE
    : COLLAPSED_REPLACE_PREVIEW_MAX_CHARS_PER_LINE;
  const normalizedLines = value.replace(/\r\n|\r/g, "\n").split("\n");
  const shownLines = normalizedLines.slice(0, maxLines).map((line) =>
    theme.fg("toolDiffContext", boundLine(line, maxCharactersPerLine, theme)),
  );
  const omittedLineCount = normalizedLines.length - shownLines.length;
  if (omittedLineCount > 0) {
    const hint = expanded ? "" : "; Ctrl+O to expand";
    shownLines.push(theme.fg("muted", `... ${omittedLineCount} lines omitted${hint}`));
  }

  return [labelText, ...shownLines].join("\n");
}

function formatReplaceDiff(diff: string, expanded: boolean, theme: ReplaceRenderTheme): string {
  const maxLines = expanded ? EXPANDED_REPLACE_DIFF_MAX_LINES : COLLAPSED_REPLACE_DIFF_MAX_LINES;
  const maxCharactersPerLine = expanded
    ? EXPANDED_REPLACE_DIFF_MAX_CHARS_PER_LINE
    : COLLAPSED_REPLACE_DIFF_MAX_CHARS_PER_LINE;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const boundedLines = lines
    .slice(0, maxLines)
    .map((line) => boundLine(line, maxCharactersPerLine, theme));
  const shownLines = colorPatchDiffLines(boundedLines, theme);
  const omittedLineCount = lines.length - shownLines.length;
  if (omittedLineCount > 0) {
    const noun = omittedLineCount === 1 ? "line" : "lines";
    const hint = expanded ? "" : "; Ctrl+O to expand";
    shownLines.push(theme.fg("muted", `... ${omittedLineCount} more diff ${noun} omitted${hint}`));
  }
  return shownLines.join("\n");
}

function boundLine(line: string, maxCharacters: number, theme: ReplaceRenderTheme): string {
  if (line.length <= maxCharacters) return line;
  const omittedCharacterCount = line.length - maxCharacters;
  return `${line.slice(0, maxCharacters)}${theme.fg("muted", `... ${omittedCharacterCount} chars omitted`)}`;
}
