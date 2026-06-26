import { InvalidPatchError } from "./errors.js";
import { HASH_SEPARATOR, isHash, type HashFunction, hashLine } from "./hash.js";

export type MatchPatchOpKind = "context" | "delete";
export type RangePatchOpKind = "context" | "delete";
export type PatchOpKind = MatchPatchOpKind | "insert" | "range";

export type PatchOp = MatchPatchOp | InsertPatchOp | RangePatchOp;

export interface MatchPatchOp {
  kind: MatchPatchOpKind;
  hash?: string;
  content?: string;
}

export interface InsertPatchOp {
  kind: "insert";
  hash: string;
  content: string;
}

export interface RangePatchOp {
  kind: "range";
  rangeKind: RangePatchOpKind;
}

export interface Hunk {
  ops: PatchOp[];
}

export interface Patch {
  hunks: Hunk[];
}

const OP_KIND_BY_PREFIX: Record<string, MatchPatchOpKind | "insert"> = {
  " ": "context",
  "-": "delete",
  "+": "insert"
};

export function parsePatch(patchText: string, hashFn: HashFunction = hashLine): Patch {
  const lines = splitPatchLines(patchText);
  let index = 0;
  const hunks: Hunk[] = [];

  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    throw new InvalidPatchError("Patch is empty.");
  }

  if (lines[index]?.startsWith("--- ") || lines[index]?.startsWith("+++ ")) {
    throw new InvalidPatchError("File headers are not supported inside Codex-style Update File sections.");
  }

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      throw new InvalidPatchError("File headers are not supported inside Codex-style Update File sections.");
    }
    if (line.startsWith("@@") && line !== "@@") {
      throw new InvalidPatchError("Hunk header must be exactly '@@' with no line numbers.");
    }
    if (line !== "@@") {
      throw new InvalidPatchError(`Expected hunk header '@@', got '${line}'.`);
    }
    index += 1;

    const ops: PatchOp[] = [];
    while (index < lines.length && lines[index] !== "@@") {
      const opLine = lines[index];
      if (opLine.startsWith("--- ") || opLine.startsWith("+++ ")) {
        throw new InvalidPatchError("File headers are not supported inside Codex-style Update File sections.");
      }
      if (opLine.startsWith("@@")) {
        throw new InvalidPatchError("Hunk header must be exactly '@@' with no line numbers.");
      }
      ops.push(parsePatchOp(opLine, hashFn));
      index += 1;
    }

    if (ops.length === 0) {
      throw new InvalidPatchError("Hunk must contain at least one operation.");
    }
    hunks.push({ ops });
  }

  if (hunks.length === 0) {
    throw new InvalidPatchError("Patch must contain at least one hunk.");
  }

  return { hunks };
}

function parsePatchOp(line: string, hashFn: HashFunction): PatchOp {
  if (line === " ...") {
    return { kind: "range", rangeKind: "context" };
  }
  if (line === "-...") {
    return { kind: "range", rangeKind: "delete" };
  }

  const prefix = line[0];

  const kind = OP_KIND_BY_PREFIX[prefix];
  if (!kind) {
    throw new InvalidPatchError(`Malformed patch operation '${line}'.`);
  }

  const body = line.slice(1);
  if (kind === "insert") {
    if (looksLikeHashline(body)) {
      throw new InvalidPatchError("Insert lines must be literal content prefixed with '+', not HASH│content from read output.");
    }
    return { kind, hash: hashFn(body), content: body };
  }

  if (body.startsWith(HASH_SEPARATOR)) {
    return { kind, content: body.slice(HASH_SEPARATOR.length) };
  }

  const separatorIndex = body.indexOf(HASH_SEPARATOR);
  if (separatorIndex === 4 && isHash(body.slice(0, 4))) {
    return { kind, hash: body.slice(0, 4), content: body.slice(4 + HASH_SEPARATOR.length) };
  }

  if (isHash(body)) {
    return { kind, hash: body };
  }

  const hint = body.includes(HASH_SEPARATOR)
    ? "Use HASH│text or │text for context/delete lines; the hash must be exactly 4 valid characters before the separator."
    : "Context/delete lines must contain a 4-character hash, HASH│text, or │text.";
  throw new InvalidPatchError(`Malformed ${kind} operation '${line}'. ${hint}`);
}

function looksLikeHashline(value: string): boolean {
  return value.length > 4 && isHash(value.slice(0, 4)) && value[4] === HASH_SEPARATOR;
}

function splitPatchLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
