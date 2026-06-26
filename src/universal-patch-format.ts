import { InvalidPatchError } from "./errors.js";
import { type HashFunction, hashLine } from "./hash.js";
import { parsePatch, type Patch } from "./patch-format.js";

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

type SectionKind = UniversalPatchOperation["kind"];

interface SectionHeader {
  kind: SectionKind;
  path: string;
}

const SECTION_HEADER_PATTERN = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

export function parseUniversalPatch(patchText: string, hashFn: HashFunction = hashLine): UniversalPatch {
  const lines = splitPatchLines(patchText);
  if (lines[0] !== "*** Begin Patch") {
    throw new InvalidPatchError("Universal patch must start with '*** Begin Patch'.");
  }
  if (lines.at(-1) !== "*** End Patch") {
    throw new InvalidPatchError("Universal patch must end with '*** End Patch'.");
  }

  const operations: UniversalPatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const header = parseSectionHeader(lines[index]);
    index += 1;
    const body: string[] = [];
    while (index < lines.length - 1 && !isSectionHeader(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    operations.push(parseSection(header, body, hashFn));
  }

  if (operations.length === 0) {
    throw new InvalidPatchError("Universal patch must contain at least one file operation.");
  }
  rejectDuplicatePaths(operations);
  return { operations };
}

export function parsePatchInput(patchText: string, hashFn: HashFunction = hashLine): UniversalPatch {
  const firstMeaningfulLine = splitPatchLines(patchText).find((line) => line.length > 0);
  if (firstMeaningfulLine !== "*** Begin Patch") {
    throw new InvalidPatchError("Patch must be a Codex-like universal patch starting with '*** Begin Patch'.");
  }
  return parseUniversalPatch(patchText, hashFn);
}

export function serializeUniversalPatch(operations: readonly UniversalPatchOperation[]): string {
  return ["*** Begin Patch", ...operations.flatMap(serializeOperation), "*** End Patch"].join("\n");
}

function serializeOperation(operation: UniversalPatchOperation): string[] {
  if (operation.kind === "add") {
    return [`*** Add File: ${operation.path}`, ...operation.lines.map((line) => `+${line}`)];
  }
  if (operation.kind === "delete") {
    return [`*** Delete File: ${operation.path}`];
  }
  return [`*** Update File: ${operation.path}`, ...operation.patch.hunks.flatMap((hunk) => [serializeHunkHeader(hunk), ...hunk.ops.map(serializePatchOp)])];
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

function serializePatchOp(op: Patch["hunks"][number]["ops"][number]): string {
  if (op.kind === "range") return rangePatchOp(op.rangeKind);
  if (op.kind === "insert") return `+${op.content}`;
  if (op.hash !== undefined && op.content !== undefined) {
    throw new InvalidPatchError("Hash+text locators are not supported; serialize hash-only or text-only patch operations.");
  }
  if (op.hash !== undefined) return `${hashPatchOpPrefix(op.kind)}${op.hash}`;
  return `${textPatchOpPrefix(op.kind)}${op.content ?? ""}`;
}

function rangePatchOp(kind: "context" | "delete"): string {
  return `${kind === "context" ? " " : "-"}...`;
}

function textPatchOpPrefix(kind: "context" | "delete"): string {
  return kind === "context" ? " :" : "-:";
}

function hashPatchOpPrefix(kind: "context" | "delete"): string {
  return kind === "context" ? " #" : "-#";
}

function parseSection(header: SectionHeader, body: readonly string[], hashFn: HashFunction): UniversalPatchOperation {
  if (header.kind === "add") {
    const lines = parseAddFileLines(body);
    return { kind: "add", path: header.path, lines, finalNewline: addFileRequiresFinalNewline(lines) };
  }

  if (header.kind === "delete") {
    validateDeleteFileBody(body);
    return { kind: "delete", path: header.path };
  }

  const patch = parsePatch(body.join("\n"), hashFn);
  return { kind: "update", path: header.path, patch };
}

function parseAddFileLines(body: readonly string[]): string[] {
  return body.map((line) => {
    if (!line.startsWith("+")) {
      throw new InvalidPatchError("Add File body lines must start with '+'.");
    }
    return line.slice(1);
  });
}

function addFileRequiresFinalNewline(lines: readonly string[]): boolean {
  // A trailing '+' row is a logical blank line; it needs a terminator to parse back as a line, not as EOF.
  return lines.at(-1) === "";
}

function validateDeleteFileBody(body: readonly string[]): void {
  if (body.length > 0) {
    throw new InvalidPatchError("Delete File sections must not include hunks or body lines.");
  }
}

function parseSectionHeader(line: string): SectionHeader {
  const match = SECTION_HEADER_PATTERN.exec(line);
  if (!match) {
    throw new InvalidPatchError(`Expected file operation header, got '${line}'.`);
  }

  const path = match[2].trim();
  if (path.length === 0) {
    throw new InvalidPatchError("File operation path cannot be empty.");
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

function rejectDuplicatePaths(operations: readonly UniversalPatchOperation[]): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    if (seen.has(operation.path)) {
      throw new InvalidPatchError(`Multiple operations for the same path are not supported: ${operation.path}`);
    }
    seen.add(operation.path);
  }
}

function splitPatchLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
