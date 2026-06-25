import { InvalidPatchError } from "./errors.js";
import { HASH_SEPARATOR, isHash, type HashFunction, hashLine } from "./hash.js";

export type PatchOpKind = "context" | "delete" | "insert";

export interface PatchOp {
  kind: PatchOpKind;
  hash: string;
  content: string;
}

export interface Hunk {
  ops: PatchOp[];
}

export interface Patch {
  hunks: Hunk[];
}

const OP_KIND_BY_PREFIX: Record<string, PatchOpKind> = {
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

  if (!isHash(body)) {
    const hint = body.includes(HASH_SEPARATOR)
      ? "Use only the 4-character hash for context/delete lines; remove the HASH│content suffix."
      : "Context/delete lines must contain only a 4-character hash.";
    throw new InvalidPatchError(`Malformed ${kind} operation '${line}'. ${hint}`);
  }

  return { kind, hash: body, content: "" };
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
