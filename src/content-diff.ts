import type { ApplyPatchResult, PatchTranscriptLine } from "./apply.js";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { hashLine } from "./hash.js";
import { parseText } from "./text-lines.js";

export type PatchTranscriptDiffKind = "add" | "update";

export interface PatchTranscriptDiffInput {
  kind: PatchTranscriptDiffKind;
  path: string;
  oldText?: string;
  newText?: string;
  applyResult?: ApplyPatchResult;
}

export function renderPatchTranscriptDiffs(inputs: readonly PatchTranscriptDiffInput[]): string {
  return inputs.map(renderPatchTranscriptDiff).join("\n");
}

export function renderPatchUnifiedDiffs(inputs: readonly PatchTranscriptDiffInput[]): string {
  return inputs
    .map((input) => generateUnifiedPatch(input.path, input.oldText ?? "", input.newText ?? ""))
    .join("");
}

export function renderPatchHashReceiptDiffs(inputs: readonly PatchTranscriptDiffInput[]): string {
  return inputs.map(renderPatchHashReceiptDiff).join("\n");
}

export function renderPatchHashReceiptDiff(input: PatchTranscriptDiffInput): string {
  return [renderUniversalPatchHeader(input), ...renderHashReceiptBody(input)].join("\n");
}

export function renderPatchTranscriptDiff(input: PatchTranscriptDiffInput): string {
  return [renderOldPathHeader(input), renderNewPathHeader(input), ...renderTranscriptBody(input)].join("\n");
}

function renderOldPathHeader(input: PatchTranscriptDiffInput): string {
  return `--- ${input.kind === "add" ? "/dev/null" : `a/${input.path}`}`;
}

function renderNewPathHeader(input: PatchTranscriptDiffInput): string {
  return `+++ b/${input.path}`;
}

function renderUniversalPatchHeader(input: PatchTranscriptDiffInput): string {
  const operation = input.kind === "add" ? "Add" : "Update";
  return `*** ${operation} File: ${input.path}`;
}

function renderHashReceiptBody(input: PatchTranscriptDiffInput): string[] {
  if (input.kind === "add") {
    return ["@@ add file @@", ...parseText(input.newText ?? "").lines.map((line) => `+${hashLine(line)}`)];
  }

  if (!input.applyResult) {
    throw new Error("Update hash receipt requires applyResult.");
  }

  return input.applyResult.hunkTranscripts.flatMap((hunk) => [
    hunk.matchStart === null ? "@@ empty file @@" : `@@ matched line ${hunk.matchStart + 1} @@`,
    ...hunk.lines.flatMap(renderHashReceiptLine)
  ]);
}

function renderHashReceiptLine(line: PatchTranscriptLine): string[] {
  if (line.kind === "insert") return [`+${hashLine(line.content)}`];
  if (line.kind === "context") return [` ${hashLine(line.content)}`];
  return [];
}

function renderTranscriptBody(input: PatchTranscriptDiffInput): string[] {
  if (input.kind === "add") {
    return ["@@ add file @@", ...parseText(input.newText ?? "").lines.map((line) => `+${line}`)];
  }

  if (!input.applyResult) {
    throw new Error("Update diff transcript requires applyResult.");
  }

  return input.applyResult.hunkTranscripts.flatMap((hunk) => [
    hunk.matchStart === null ? "@@ empty file @@" : `@@ matched line ${hunk.matchStart + 1} @@`,
    ...hunk.lines.map(renderTranscriptLine)
  ]);
}

function renderTranscriptLine(line: PatchTranscriptLine): string {
  const prefix = line.kind === "insert" ? "+" : line.kind === "delete" ? "-" : " ";
  return `${prefix}${line.content}`;
}

