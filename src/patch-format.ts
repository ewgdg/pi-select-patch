import { annotatePatchErrorLocation, InvalidPatchError } from "./errors.js";
import { isHash, type HashFunction, hashLine } from "./hash.js";

export type MatchPatchOpKind = "context" | "delete";
export type RangePatchOpKind = "context" | "delete";
export type PatchOpKind = MatchPatchOpKind | "insert" | "range";

export type PatchOp = MatchPatchOp | InsertPatchOp | RangePatchOp;

export type TextSelectorKind = "exact" | "prefix" | "suffix" | "contains";

export interface CombinedTextSelector {
  prefix?: string;
  contains?: string[];
  suffix?: string;
}

export interface MatchPatchOp {
  kind: MatchPatchOpKind;
  hash?: string;
  content?: string;
  textSelector?: TextSelectorKind;
  combinedSelector?: CombinedTextSelector;
  unifiedDiff?: boolean;
  smart?: boolean;
  inputLine?: number;
  authoredCharCount?: number;
}

export interface InsertPatchOp {
  kind: "insert";
  hash: string;
  content: string;
  inputLine?: number;
  authoredCharCount?: number;
}

export interface RangePatchOp {
  kind: "range";
  rangeKind: RangePatchOpKind;
  inputLine?: number;
  authoredCharCount?: number;
}

export interface HunkAnchorHint {
  line: number;
  endLine?: number;
}

export interface Hunk {
  anchorHint?: HunkAnchorHint;
  ops: PatchOp[];
  inputLine?: number;
}

export interface Patch {
  hunks: Hunk[];
}

export function parsePatch(patchText: string, hashFn: HashFunction = hashLine, lineOffset = 0): Patch {
  const lines = splitPatchLines(patchText);
  let index = 0;
  const hunks: Hunk[] = [];

  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    throw new InvalidPatchError("Patch is empty.");
  }

  if (lines[index]?.startsWith("--- ") || lines[index]?.startsWith("+++ ")) {
    throw new InvalidPatchError("File headers are not supported inside Codex-style Update File sections.", { inputLine: patchInputLine(index, lineOffset) });
  }

  while (index < lines.length) {
    const line = lines[index];
    const hunkHeaderLine = patchInputLine(index, lineOffset);
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      throw new InvalidPatchError("File headers are not supported inside Codex-style Update File sections.", { inputLine: hunkHeaderLine });
    }
    const anchorHint = parseHunkHeader(line, hunkHeaderLine);
    index += 1;

    const opLines: PatchOperationLine[] = [];
    while (index < lines.length && !isHunkHeaderLine(lines[index])) {
      const opLine = lines[index];
      const operationLine = patchInputLine(index, lineOffset);
      if (opLine.startsWith("--- ") || opLine.startsWith("+++ ")) {
        throw new InvalidPatchError("File headers are not supported inside Codex-style Update File sections.", { inputLine: operationLine });
      }
      if (opLine.startsWith("@@")) {
        parseHunkHeader(opLine, operationLine);
      }
      opLines.push({ line: opLine, inputLine: operationLine });
      index += 1;
    }

    const ops = parseHunkOperationLines(opLines, hashFn);
    if (ops.length === 0) {
      throw new InvalidPatchError("Hunk must contain at least one operation.", { inputLine: hunkHeaderLine });
    }
    hunks.push({ ...(anchorHint ? { anchorHint } : {}), ops, inputLine: hunkHeaderLine });
  }

  if (hunks.length === 0) {
    throw new InvalidPatchError("Patch must contain at least one hunk.");
  }

  return { hunks };
}


interface PatchOperationLine {
  line: string;
  inputLine: number;
}

function parseHunkOperationLines(opLines: readonly PatchOperationLine[], hashFn: HashFunction): PatchOp[] {
  return opLines.map((opLine) => {
    if (hasMissingLocatorMarker(opLine.line)) {
      return parseUnifiedDiffOp(opLine.line, hashFn, opLine.inputLine);
    }
    if (hasOmittedContextOperator(opLine.line)) {
      return parseSelectorPatchOp("context", opLine.line, opLine.line, opLine.inputLine);
    }
    return parsePatchOp(opLine.line, hashFn, opLine.inputLine);
  });
}

const HUNK_HEADER_PATTERN = /^@@(?: @([1-9]\d*)(?:\.\.\.([1-9]\d*))?)?$/;

function isHunkHeaderLine(line: string): boolean {
  return HUNK_HEADER_PATTERN.test(line);
}

function parseHunkHeader(line: string, inputLine: number): HunkAnchorHint | undefined {
  const match = HUNK_HEADER_PATTERN.exec(line);
  if (!match) {
    if (line.startsWith("@@")) {
      throw new InvalidPatchError("Malformed hunk header. Use @@, @@ @<positive-line>, or @@ @<start>...<end>.", { inputLine });
    }
    throw new InvalidPatchError("Expected hunk header.", { inputLine });
  }

  const lineText = match[1];
  if (lineText === undefined) return undefined;

  const hintLine = Number(lineText);
  const endLineText = match[2];
  const endLine = endLineText === undefined ? undefined : Number(endLineText);
  if (!Number.isSafeInteger(hintLine) || (endLine !== undefined && !Number.isSafeInteger(endLine))) {
    throw new InvalidPatchError("Malformed hunk anchor hint. Line numbers must be safe positive integers.", { inputLine });
  }
  if (endLine !== undefined && hintLine > endLine) {
    throw new InvalidPatchError("Malformed hunk anchor hint. Start line must be less than or equal to end line.", { inputLine });
  }
  return endLine === undefined ? { line: hintLine } : { line: hintLine, endLine };
}

function hasMissingLocatorMarker(line: string): boolean {
  if (line === "") return true;
  if (line.startsWith("+")) return false;
  if (!(line.startsWith(" ") || line.startsWith("-"))) return false;

  const selector = line.slice(1);
  if (selector === "") return line.startsWith("-");
  return !hasLocatorMarker(selector);
}

function hasOmittedContextOperator(line: string): boolean {
  return hasLocatorMarker(line);
}

function hasLocatorMarker(selector: string): boolean {
  return selector === "..." || selector.startsWith(":") || selector.startsWith("#") || selector.startsWith("^") || selector.startsWith("*") || selector.startsWith("?") || selector.startsWith("$") || selector.startsWith("~");
}

function parseUnifiedDiffOp(line: string, hashFn: HashFunction, inputLine: number): PatchOp {
  if (line === "") {
    return { kind: "context", content: "", textSelector: "exact", unifiedDiff: true, inputLine, authoredCharCount: line.length };
  }
  if (line.startsWith("+")) {
    const content = line.slice(1);
    return { kind: "insert", hash: hashFn(content), content, inputLine, authoredCharCount: line.length };
  }
  if (line.startsWith(" ")) {
    return { kind: "context", content: line.slice(1), textSelector: "exact", unifiedDiff: true, inputLine, authoredCharCount: line.length };
  }
  if (line.startsWith("-")) {
    return { kind: "delete", content: line.slice(1), textSelector: "exact", unifiedDiff: true, inputLine, authoredCharCount: line.length };
  }

  throw new InvalidPatchError("Malformed patch operation. Use context, delete, insert, or locator row.", { inputLine });
}

function parsePatchOp(line: string, hashFn: HashFunction, inputLine: number): PatchOp {
  if (line.startsWith("+")) {
    const content = line.slice(1);
    return { kind: "insert", hash: hashFn(content), content, inputLine, authoredCharCount: line.length };
  }
  if (line.startsWith(" ")) {
    return parseSelectorPatchOp("context", line.slice(1), line, inputLine);
  }
  if (line.startsWith("-")) {
    return parseSelectorPatchOp("delete", line.slice(1), line, inputLine);
  }

  throw new InvalidPatchError("Malformed patch operation. Use context, delete, insert, or locator row.", { inputLine });
}

function parseSelectorPatchOp(kind: MatchPatchOpKind, selector: string, line: string, inputLine: number): PatchOp {
  if (kind === "context" && selector === "") {
    return { kind, content: "", textSelector: "exact", inputLine, authoredCharCount: line.length };
  }
  if (selector === "...") {
    return { kind: "range", rangeKind: kind, inputLine, authoredCharCount: line.length };
  }
  if (selector.startsWith(":")) {
    return { kind, content: selector.slice(1), textSelector: "exact", inputLine, authoredCharCount: line.length };
  }
  if (selector.startsWith("~")) {
    return parseSmartPatchOp(kind, selector.slice(1), line, inputLine);
  }
  if (selector.startsWith("#")) {
    return parseHashPatchOp(kind, selector.slice(1), line, inputLine);
  }
  if (selector.startsWith("^")) {
    return parsePrefixPatchOp(kind, selector.slice(1), line, inputLine);
  }
  if (selector.startsWith("*")) {
    return parseContainsPatchOp(kind, selector.slice(1), line, inputLine);
  }
  if (selector.startsWith("?")) {
    return parseCombinedPatchOp(kind, selector.slice(1), line, inputLine);
  }
  if (selector.startsWith("$")) {
    return parseSuffixPatchOp(kind, selector.slice(1), line, inputLine);
  }

  throwRawTextSelectorError(kind, selector, line, inputLine);
}


function parseSmartPatchOp(kind: MatchPatchOpKind, content: string, _line: string, inputLine: number): MatchPatchOp {
  if (content.length === 0) {
    throw new InvalidPatchError(`Malformed ${kind} smart locator. Expected non-empty text after ~.`, { inputLine });
  }
  return { kind, content, textSelector: "exact", smart: true, inputLine, authoredCharCount: _line.length };
}

function throwRawTextSelectorError(kind: MatchPatchOpKind, _selector: string, _line: string, inputLine: number): never {
  throw new InvalidPatchError(`Raw ${kind} row. Add a locator marker.`, { inputLine });
}

function parsePrefixPatchOp(kind: MatchPatchOpKind, content: string, _line: string, inputLine: number): MatchPatchOp {
  if (content.length === 0) {
    throw new InvalidPatchError(`Malformed ${kind} prefix locator. Expected non-empty text after ^.`, { inputLine });
  }
  return { kind, content, textSelector: "prefix", inputLine, authoredCharCount: _line.length };
}

function parseContainsPatchOp(kind: MatchPatchOpKind, content: string, _line: string, inputLine: number): MatchPatchOp {
  if (content.length === 0) {
    throw new InvalidPatchError(`Malformed ${kind} contains locator. Expected non-empty text after *.`, { inputLine });
  }
  return { kind, content, textSelector: "contains", inputLine, authoredCharCount: _line.length };
}

function parseCombinedPatchOp(kind: MatchPatchOpKind, jsonText: string, _line: string, inputLine: number): MatchPatchOp {
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new InvalidPatchError(`Malformed ${kind} combined locator. Expected valid JSON after ?.`, { inputLine });
  }

  try {
    return { kind, combinedSelector: normalizeCombinedTextSelector(value, `Malformed ${kind} combined locator. Combined selector`), inputLine, authoredCharCount: _line.length };
  } catch (error) {
    throw annotatePatchErrorLocation(error, { inputLine });
  }
}

export function normalizeCombinedTextSelector(value: unknown, description = "Combined selector"): CombinedTextSelector {
  if (!isJsonObject(value)) {
    throw new InvalidPatchError(`${description} must be a JSON object.`);
  }

  const allowedKeys = new Set(["prefix", "contains", "suffix"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new InvalidPatchError(`${description} has unknown key.`);
    }
  }

  const prefix = parseOptionalCombinedString(value.prefix, "prefix", description);
  const suffix = parseOptionalCombinedString(value.suffix, "suffix", description);
  const contains = parseOptionalCombinedContains(value.contains, description);

  if (prefix === undefined && suffix === undefined && contains === undefined) {
    throw new InvalidPatchError(`${description} requires at least one of prefix, contains, or suffix.`);
  }

  return { ...(prefix !== undefined ? { prefix } : {}), ...(contains !== undefined ? { contains } : {}), ...(suffix !== undefined ? { suffix } : {}) };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalCombinedString(value: unknown, key: "prefix" | "suffix", description: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidPatchError(`${description} ${key} must be a non-empty string.`);
  }
  return value;
}

function parseOptionalCombinedContains(value: unknown, description: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new InvalidPatchError(`${description} contains must be a non-empty string or non-empty array of non-empty strings.`);
    }
    return [value];
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new InvalidPatchError(`${description} contains must be a non-empty string or non-empty array of non-empty strings.`);
  }
  return value;
}

function parseSuffixPatchOp(kind: MatchPatchOpKind, content: string, _line: string, inputLine: number): MatchPatchOp {
  if (content.length === 0) {
    throw new InvalidPatchError(`Malformed ${kind} suffix locator. Expected non-empty text after $.`, { inputLine });
  }
  return { kind, content, textSelector: "suffix", inputLine, authoredCharCount: _line.length };
}

function parseHashPatchOp(kind: MatchPatchOpKind, hash: string, _line: string, inputLine: number): MatchPatchOp {
  if (!isHash(hash)) {
    throw new InvalidPatchError(`Malformed ${kind} hash locator. Expected 3 or 4 base64url characters after #.`, { inputLine });
  }
  return { kind, hash, inputLine, authoredCharCount: _line.length };
}

function patchInputLine(index: number, lineOffset: number): number {
  return lineOffset + index + 1;
}

function splitPatchLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
