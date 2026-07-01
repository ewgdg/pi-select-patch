import { dedentBlockWithLineOffset } from "./dedent.js";
import { InvalidPatchError } from "./errors.js";
import { type HashFunction, hashLine } from "./hash.js";
import { normalizeCombinedTextSelector, parsePatch, type ParsePatchOptions, type Patch, type PatchParseProfile } from "./patch-format.js";

export type UniversalPatchOperation = AddFileOperation | UpdateFileOperation | DeleteFileOperation;

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

export interface DeleteFileOperation {
  kind: "delete";
  path: string;
}

export interface UniversalPatch {
  operations: UniversalPatchOperation[];
}

export interface SerializeUniversalPatchOptions {
  profile?: PatchParseProfile;
  strictHashRows?: boolean;
}

type SectionKind = UniversalPatchOperation["kind"];

interface SectionHeader {
  kind: SectionKind;
  path: string;
}

const SECTION_HEADER_PATTERN = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const OPENING_BOUNDARY = "*** Begin Patch";
const CLOSING_BOUNDARY = "*** End Patch";

export function parseUniversalPatch(patchText: string, hashFn: HashFunction = hashLine, options: ParsePatchOptions = {}): UniversalPatch {
  const { lines, lineOffset } = normalizePatchInput(patchText);
  const hasBoundaries = lines[0] === OPENING_BOUNDARY;
  if (hasBoundaries && lines.at(-1) !== CLOSING_BOUNDARY) {
    throw new InvalidPatchError("Patch boundary is incomplete.", { inputLine: lineOffset + Math.max(lines.length, 1) });
  }

  const startIndex = hasBoundaries ? 1 : 0;
  const endIndex = hasBoundaries ? lines.length - 1 : lines.length;

  const operations: UniversalPatchOperation[] = [];
  let index = startIndex;
  while (index < endIndex) {
    const header = parseSectionHeader(lines[index], lineOffset + index + 1);
    index += 1;
    const bodyStartLine = lineOffset + index + 1;
    const body: string[] = [];
    while (index < endIndex && !isSectionHeader(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    operations.push(parseSection(header, body, hashFn, bodyStartLine, options));
  }

  if (operations.length === 0) {
    throw new InvalidPatchError("Universal patch must contain at least one file operation.");
  }
  return { operations };
}

export function parsePatchInput(patchText: string, hashFn: HashFunction = hashLine, options: ParsePatchOptions = {}): UniversalPatch {
  return parseUniversalPatch(patchText, hashFn, options);
}

export function serializeUniversalPatch(operations: readonly UniversalPatchOperation[], options: SerializeUniversalPatchOptions = {}): string {
  return ["*** Begin Patch", ...operations.flatMap((operation) => serializeOperation(operation, options)), "*** End Patch"].join("\n");
}

function serializeOperation(operation: UniversalPatchOperation, options: SerializeUniversalPatchOptions): string[] {
  if (operation.kind === "add") {
    return [`*** Add File: ${operation.path}`, ...operation.lines.map((line) => `+${line}`)];
  }
  if (operation.kind === "delete") {
    return [`*** Delete File: ${operation.path}`];
  }
  return [`*** Update File: ${operation.path}`, ...operation.patch.hunks.flatMap((hunk) => [serializeHunkHeader(hunk), ...hunk.ops.map((op) => serializePatchOp(op, options))])];
}

function serializeHunkHeader(hunk: Patch["hunks"][number]): string {
  if (!hunk.anchorHint) return "@@";
  if (!Number.isSafeInteger(hunk.anchorHint.line) || hunk.anchorHint.line < 1) {
    throw new InvalidPatchError("Hunk anchor hint line must be a safe positive integer.");
  }
  if (hunk.anchorHint.endLine === undefined) return `@@ @${hunk.anchorHint.line}`;
  if (!Number.isSafeInteger(hunk.anchorHint.endLine) || hunk.anchorHint.endLine < 1 || hunk.anchorHint.line > hunk.anchorHint.endLine) {
    throw new InvalidPatchError("Hunk anchor hint range must use safe positive integers with start less than or equal to end.");
  }
  return `@@ @${hunk.anchorHint.line}...${hunk.anchorHint.endLine}`;
}

function serializePatchOp(op: Patch["hunks"][number]["ops"][number], options: SerializeUniversalPatchOptions): string {
  if (op.kind === "range") return rangePatchOp(op.rangeKind, options);
  if (op.kind === "insert") return `+${op.content}`;
  if (op.hash !== undefined && (op.content !== undefined || op.combinedSelector !== undefined)) {
    throw new InvalidPatchError("Hash+text locators are not supported; serialize hash-only or text-only patch operations.");
  }
  if (op.content !== undefined && op.combinedSelector !== undefined) {
    throw new InvalidPatchError("Mixed text locators are not supported; serialize exactly one text locator form.");
  }
  if (op.hash !== undefined) return `${hashPatchOpPrefix(op.kind, options)}${op.hash}`;
  return serializeTextSelector(op, options);
}

function serializeTextSelector(op: Patch["hunks"][number]["ops"][number], options: SerializeUniversalPatchOptions): string {
  if (op.kind === "insert" || op.kind === "range") return "";
  if (op.combinedSelector !== undefined) {
    const combinedSelector = normalizeCombinedTextSelector(op.combinedSelector, "Combined selector");
    return `${op.kind === "context" ? " ?" : "-?"}${JSON.stringify(combinedSelector)}`;
  }
  if (op.smart === true) {
    if (op.content === undefined || op.content.length === 0) {
      throw new InvalidPatchError("Smart locators require non-empty text content.");
    }
    if (usesSmartMarkerlessRows(op, options)) return op.kind === "context" ? op.content : `-${op.content}`;
    return `${op.kind === "context" ? " ~" : "-~"}${op.content}`;
  }
  if (op.textSelector === "prefix") return `${op.kind === "context" ? " ^" : "-^"}${op.content ?? ""}`;
  if (op.textSelector === "contains") return `${op.kind === "context" ? " *" : "-*"}${op.content ?? ""}`;
  if (op.textSelector === "suffix") return `${op.kind === "context" ? " $" : "-$"}${op.content ?? ""}`;
  return `${textPatchOpPrefix(op.kind)}${op.content ?? ""}`;
}

function rangePatchOp(kind: "context" | "delete", options: SerializeUniversalPatchOptions): string {
  return `${kind === "context" ? contextPrefix(options) : "-"}...`;
}

function textPatchOpPrefix(kind: "context" | "delete"): string {
  return kind === "context" ? " :" : "-:";
}

function hashPatchOpPrefix(kind: "context" | "delete", options: SerializeUniversalPatchOptions): string {
  if (usesStrictHashRows(options)) return kind === "context" ? "" : "-";
  return kind === "context" ? " #" : "-#";
}

function contextPrefix(options: SerializeUniversalPatchOptions): string {
  return usesMarkerlessRows(options) ? "" : " ";
}

function usesStrictHashRows(options: SerializeUniversalPatchOptions): boolean {
  return options.strictHashRows === true || options.profile === "hash";
}

function usesSmartMarkerlessRows(op: Patch["hunks"][number]["ops"][number], options: SerializeUniversalPatchOptions): boolean {
  return op.kind !== "insert" && op.kind !== "range" && op.smart === true && options.profile === "smart";
}

function usesMarkerlessRows(options: SerializeUniversalPatchOptions): boolean {
  return options.profile === "smart" || usesStrictHashRows(options);
}

function parseSection(header: SectionHeader, body: readonly string[], hashFn: HashFunction, bodyStartLine: number, options: ParsePatchOptions): UniversalPatchOperation {
  if (header.kind === "add") {
    const lines = parseAddFileLines(body, bodyStartLine);
    return { kind: "add", path: header.path, lines, finalNewline: addFileRequiresFinalNewline(lines) };
  }

  if (header.kind === "delete") {
    validateDeleteFileBody(body, bodyStartLine);
    return { kind: "delete", path: header.path };
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

function validateDeleteFileBody(body: readonly string[], bodyStartLine: number): void {
  if (body.length > 0) {
    throw new InvalidPatchError("Delete File sections must not include hunks or body lines.", { inputLine: bodyStartLine });
  }
}

function parseSectionHeader(line: string, inputLine: number): SectionHeader {
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
  if (rawKind === "Update") return "update";
  return "delete";
}

function isSectionHeader(line: string): boolean {
  return SECTION_HEADER_PATTERN.test(line);
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
