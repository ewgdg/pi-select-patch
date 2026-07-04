import { dedentBlockWithLineOffset } from "./dedent.js";
import { InvalidPatchError } from "./errors.js";
import { type HashFunction, hashLine } from "./hash.js";
import { parsePatch, type ParsePatchOptions, type Patch } from "./patch-format.js";

export type UniversalPatchOperation = AddFileOperation | UpdateFileOperation;

export interface AddFileOperation {
  kind: "add";
  path: string;
  lines: string[];
  finalNewline: boolean;
}

export interface UpdateFileOperation {
  kind: "update";
  path: string;
  patch: Patch;
}

export interface UniversalPatch {
  operations: UniversalPatchOperation[];
  source?: UniversalPatchSource;
}

export interface UniversalPatchSource {
  lines: string[];
  hasBoundaries: boolean;
  bodyEndIndex: number;
  operationSources: UniversalPatchOperationSource[];
}

export interface UniversalPatchOperationSource {
  startIndex: number;
}

type SectionKind = UniversalPatchOperation["kind"];

interface SectionHeader {
  kind: SectionKind;
  path: string;
}

const SECTION_HEADER_PATTERN = /^\*\*\* (Add|Update) File: (.+)$/;
const DELETE_SECTION_HEADER_PATTERN = /^\*\*\* Delete File: (.+)$/;
const OPENING_BOUNDARY = "*** Begin Patch";
const CLOSING_BOUNDARY = "*** End Patch";

export function parseUniversalPatch(patchText: string, hashFn: HashFunction = hashLine, options: ParsePatchOptions = {}): UniversalPatch {
  const { lines, lineOffset } = normalizePatchInput(patchText);
  const hasOpeningBoundary = lines[0] === OPENING_BOUNDARY;
  const hasClosingBoundary = lines.at(-1) === CLOSING_BOUNDARY;
  if (hasOpeningBoundary && !hasClosingBoundary) {
    throw new InvalidPatchError("Patch boundary is incomplete.", { inputLine: lineOffset + Math.max(lines.length, 1) });
  }
  const hasBoundaries = hasOpeningBoundary;

  const startIndex = hasBoundaries ? 1 : 0;
  // Agents still sometimes append the old closing boundary to section-only patches.
  // Treat one final closing boundary as harmless noise, but keep rejecting any inner boundary.
  const endIndex = hasClosingBoundary ? lines.length - 1 : lines.length;
  rejectStrayPatchBoundaries(lines, startIndex, endIndex, lineOffset);

  const operations: UniversalPatchOperation[] = [];
  const operationSources: UniversalPatchOperationSource[] = [];
  let index = startIndex;
  while (index < endIndex) {
    const sectionStartIndex = index;
    const header = parseSectionHeader(lines[index], lineOffset + index + 1);
    index += 1;
    const bodyStartLine = lineOffset + index + 1;
    const body: string[] = [];
    while (index < endIndex && !isSectionHeader(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    operations.push(parseSection(header, body, hashFn, bodyStartLine, options));
    operationSources.push({ startIndex: sectionStartIndex });
  }

  if (operations.length === 0) {
    throw new InvalidPatchError("Universal patch must contain at least one file operation.");
  }
  return {
    operations,
    source: { lines, hasBoundaries, bodyEndIndex: endIndex, operationSources },
  };
}

function rejectStrayPatchBoundaries(lines: readonly string[], startIndex: number, endIndex: number, lineOffset: number): void {
  for (let index = startIndex; index < endIndex; index += 1) {
    if (lines[index] === OPENING_BOUNDARY || lines[index] === CLOSING_BOUNDARY) {
      throw new InvalidPatchError("Unexpected patch boundary. Use both outer boundaries or omit both.", { inputLine: lineOffset + index + 1 });
    }
  }
}

export function parsePatchInput(patchText: string, hashFn: HashFunction = hashLine, options: ParsePatchOptions = {}): UniversalPatch {
  return parseUniversalPatch(patchText, hashFn, options);
}

export function copyUniversalPatchInputTail(patch: UniversalPatch, startOperationIndex: number): string {
  if (!patch.source) {
    throw new InvalidPatchError("Retry patch source input was not retained.");
  }
  const operationSource = patch.source.operationSources[startOperationIndex];
  if (!operationSource) {
    throw new InvalidPatchError("Retry patch operation index is out of range.");
  }
  const tailLines = patch.source.lines.slice(operationSource.startIndex, patch.source.bodyEndIndex);
  const retryLines = patch.source.hasBoundaries
    ? [OPENING_BOUNDARY, ...tailLines, CLOSING_BOUNDARY]
    : tailLines;
  return retryLines.join("\n");
}

function parseSection(header: SectionHeader, body: readonly string[], hashFn: HashFunction, bodyStartLine: number, options: ParsePatchOptions): UniversalPatchOperation {
  if (header.kind === "add") {
    const lines = parseAddFileLines(body, bodyStartLine);
    return { kind: "add", path: header.path, lines, finalNewline: addFileRequiresFinalNewline(lines) };
  }

  const patch = parsePatch(body.join("\n"), hashFn, bodyStartLine - 1, options);
  return { kind: "update", path: header.path, patch };
}

function parseAddFileLines(body: readonly string[], bodyStartLine: number): string[] {
  return body.map((line, index) => {
    if (!line.startsWith("+")) {
      throw new InvalidPatchError("Add File body lines must start with +.", { inputLine: bodyStartLine + index });
    }
    return line.slice(1);
  });
}

function addFileRequiresFinalNewline(lines: readonly string[]): boolean {
  // A trailing '+' row is a logical blank line; it needs a terminator to parse back as a line, not as EOF.
  return lines.at(-1) === "";
}

function parseSectionHeader(line: string, inputLine: number): SectionHeader {
  if (DELETE_SECTION_HEADER_PATTERN.test(line)) {
    throw new InvalidPatchError("Delete File sections are not supported.", { inputLine });
  }
  const match = SECTION_HEADER_PATTERN.exec(line);
  if (!match) {
    throw new InvalidPatchError("Expected file operation header.", { inputLine });
  }

  const path = match[2].trim();
  if (path.length === 0) {
    throw new InvalidPatchError("File operation path cannot be empty.", { inputLine });
  }

  return { kind: sectionKind(match[1]), path };
}

function sectionKind(rawKind: string): SectionKind {
  if (rawKind === "Add") return "add";
  return "update";
}

function isSectionHeader(line: string): boolean {
  return SECTION_HEADER_PATTERN.test(line) || DELETE_SECTION_HEADER_PATTERN.test(line);
}

function splitPatchLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function normalizePatchInput(text: string): { lines: string[]; lineOffset: number } {
  const dedented = dedentBlockWithLineOffset(text);
  return { lines: splitPatchLines(dedented.text), lineOffset: dedented.lineOffset };
}
