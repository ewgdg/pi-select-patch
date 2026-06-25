import { InvalidPatchError } from "./errors.js";
import { type HashFunction, hashLine } from "./hash.js";
import { parsePatch, type Patch } from "./patch-format.js";

export type UniversalPatchOperation = AddFileOperation | UpdateFileOperation | DeleteFileOperation;

export interface AddFileOperation {
  kind: "add";
  path: string;
  lines: string[];
}

export interface UpdateFileOperation {
  kind: "update";
  path: string;
  patch: Patch;
}

export interface DeleteFileOperation {
  kind: "delete";
  path: string;
  patch: Patch;
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

export function parsePatchInput(patchText: string, legacyPath?: string, hashFn: HashFunction = hashLine): UniversalPatch {
  const firstMeaningfulLine = splitPatchLines(patchText).find((line) => line.length > 0);
  if (firstMeaningfulLine === "*** Begin Patch") {
    return parseUniversalPatch(patchText, hashFn);
  }
  if (!legacyPath) {
    throw new InvalidPatchError("Patch must be a universal patch with file headers when no path parameter is provided.");
  }
  return {
    operations: [{ kind: "update", path: legacyPath, patch: parsePatch(patchText, hashFn) }]
  };
}

function parseSection(header: SectionHeader, body: readonly string[], hashFn: HashFunction): UniversalPatchOperation {
  if (header.kind === "add") {
    return { kind: "add", path: header.path, lines: parseAddFileLines(body) };
  }

  const patch = parsePatch(body.join("\n"), hashFn);
  if (header.kind === "delete") {
    validateDeleteFilePatch(patch);
    return { kind: "delete", path: header.path, patch };
  }

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

function validateDeleteFilePatch(patch: Patch): void {
  const ops = patch.hunks.flatMap((hunk) => hunk.ops);
  if (ops.length === 0 || ops.some((op) => op.kind !== "delete")) {
    throw new InvalidPatchError("Delete File requires one or more delete-only hashline operations as full-file evidence.");
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
