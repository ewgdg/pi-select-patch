import { constants } from "node:fs";
import { access, mkdtemp, realpath, writeFile as writeRawFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyPatchToText, type ApplyPatchResult } from "../apply.js";
import { renderPatchTranscriptDiffs, type PatchTranscriptDiffInput } from "../content-diff.js";
import { FileTextError, InvalidPatchError, PartialPatchError } from "../errors.js";
import {
  assertExistingTextFileMutationTarget,
  assertNewTextFileTarget,
  deleteExistingRegularFile,
  readExistingTextFile,
  resolveExistingRealPath,
  resolveToolPath,
  resolveNewTextFileTarget,
  writeNewTextFileAtomically,
  writeTextFileAtomically
} from "../fs-text.js";
import { HASH_SEPARATOR, hashLine, isHash } from "../hash.js";
import { countRenderedLines, getVisibleOutputOverflow, type VisibleOutputOverflow } from "../output-size.js";
import { parseText, serializeText } from "../text-lines.js";
import { parsePatchInput, serializeUniversalPatch, type AddFileOperation, type UniversalPatchOperation } from "../universal-patch-format.js";
import { buildPatchResultRenderText, getPatchResultText } from "./patch-render.js";

interface PatchReceiptDecision {
  text: string;
  omitted: boolean;
  omitReason?: "empty" | "too_large";
  overflow?: VisibleOutputOverflow;
  visibleLineCount: number;
}

interface OperationTarget {
  operation: UniversalPatchOperation;
  targetPath: string;
}

interface PlannedFileChange {
  operation: UniversalPatchOperation["kind"];
  patchPath: string;
  targetPath: string;
  oldText?: string;
  newText?: string;
  applyResult?: ApplyPatchResult;
  addedHashes?: string[];
  warnings?: string[];
}

interface DryRunFileState {
  exists: boolean;
  text?: string;
}

export const patchTool = defineTool({
  name: "patch",
  label: "Locator Patch",
  description: "Token-efficient tool for editing files with multi-file-capable add/update/delete patches.",
  promptSnippet: "Prefer for normal token-efficient file edits; supports multi-file changes in one patch call.",
  promptGuidelines: [
    "`patch` tool finds update targets by explicit context/delete locators. No fuzzy matching.",
    "Context/delete rows use `<operation><selector><locator>` syntax. The selector after the operation character must be `:`, `^`, `*`, `?`, `$`, `#`, or `...`. Raw diff rows like ` function foo()` are invalid; use exact selector row `=:function foo()`.",
    "Insert lines use raw content after `+`. Do not include hashes in `+` lines unless those hash characters are intended file content.",
    "During non-dry `patch` tool failures, the tool stops at the failed operation and writes a retry patch file containing unapplied operations. For large patches, save output tokens by editing the retry patch file and passing it via `patch_file` instead of re-emitting large patch text.",
    "On `patch` tool success, agent-visible output is a compact post-apply hash receipt/status for affected sections. Treat returned hashes as current for those sections."
  ],
  parameters: Type.Object(
    {
      patch: Type.Optional(
        Type.String({
          description:
            "Inline patch text. Mutually exclusive with `patch_file`. Must start with `*** Begin Patch` and end with `*** End Patch`. May contain multiple `*** Add File`, `*** Update File`, and `*** Delete File` sections; `*** Update File` sections may contain multiple `@@` hunks. Update hunk headers are `@@`, `@@ @<line>`, or `@@ @<start>...<end>`; `@@ @<line>` starts searching at 1-based line `<line>` and requires the resolved match start to be at or after that line, while `@@ @<start>...<end>` requires the resolved match span to stay within inclusive 1-based lines `<start>...<end>`. Update hunk context/delete rows use `<operation><selector><locator>` syntax: `=:<text>` exact context text, `-:<text>` exact delete text, `=^<prefix>` prefix context text, `-^<prefix>` prefix delete text, `=*<needle>` contains context text, `-*<needle>` contains delete text, `=?{...}` combined context text, `-?{...}` combined delete text, `=$<suffix>` suffix context text, `-$<suffix>` suffix delete text, `=#<hash>` 3/4-char hash context, `-#<hash>` 3/4-char hash delete, `=...` context range, and `-...` delete range. Insert rows use `+<content>` and have no selector. Combined selector JSON allows `prefix`, `contains`, and `suffix`; all supplied predicates must match the same line. Context/delete rows must use selectors; raw diff rows like ` function foo()` are invalid, use `=:function foo()`. Do not use read-output `HASH│content` rows as patch operations. Insert lines use raw `+{text}` content; do not include hashes in `+` lines unless those hash characters are intended file content. Example:\n```\n*** Begin Patch\n*** Update File: path/to/file.txt\n@@ @120...140\n=:start context\n=...\n=#ABC\n-...\n+replacement text\n=:end context\n*** End Patch\n```"
        })
      ),
      patch_file: Type.Optional(
        Type.String({ description: "Path to a UTF-8 patch file. Mutually exclusive with `patch`. Relative paths resolve against cwd." })
      ),
      dry_run: Type.Optional(Type.Boolean({ description: "Validate/apply in memory and do not write." }))
    },
    { additionalProperties: false }
  ),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (signal?.aborted) {
      throw new Error("Cancelled");
    }

    const patchText = await readPatchInput(params.patch, params.patch_file, ctx.cwd);
    const universalPatch = parsePatchInput(patchText);
    const dryRun = params.dry_run ?? false;

    if (dryRun) {
      return buildPatchToolResult(await planFileChangesForDryRun(ctx.cwd, universalPatch.operations), true);
    }

    const plannedChanges: PlannedFileChange[] = [];
    for (const [index, operation] of universalPatch.operations.entries()) {
      if (signal?.aborted) {
        throw new Error("Cancelled");
      }

      try {
        const change = await applyOperationSequentially(ctx.cwd, operation);
        plannedChanges.push(change);
      } catch (error) {
        const retryPatchPath = await writeRetryPatch(universalPatch.operations.slice(index));
        const partialError = new PartialPatchError(
          renderSequentialFailureMessage({
            appliedChanges: plannedChanges,
            failedOperation: operation,
            skippedOperations: universalPatch.operations.slice(index + 1),
            retryPatchPath,
            cause: error
          })
        );
        Object.assign(partialError, {
          appliedOperationCount: plannedChanges.length,
          failedOperationIndex: index,
          retryPatchPath
        });
        throw partialError;
      }
    }

    return buildPatchToolResult(plannedChanges, false);
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    const resultText = getPatchResultText(result);
    return new Text(
      buildPatchResultRenderText({
        resultText,
        details: result.details,
        expanded,
        isPartial,
        isError: context.isError || resultText?.startsWith("Error") === true,
        theme
      }),
      0,
      0
    );
  }
});

async function readPatchInput(patch: string | undefined, patchFile: string | undefined, cwd: string): Promise<string> {
  const hasInlinePatch = typeof patch === "string";
  const hasPatchFile = typeof patchFile === "string";
  if (hasInlinePatch === hasPatchFile) {
    throw new InvalidPatchError("Provide exactly one of 'patch' or 'patch_file'.");
  }
  if (hasInlinePatch) {
    return patch;
  }

  const patchFilePath = resolveToolPath(cwd, patchFile ?? "");
  const { text } = await readExistingTextFile(patchFilePath);
  return text;
}

async function applyOperationSequentially(cwd: string, operation: UniversalPatchOperation): Promise<PlannedFileChange> {
  const operationTarget = await prepareOperationTarget(cwd, operation);
  return withFileMutationQueue(operationTarget.targetPath, async () => {
    const change = await planFileChange(operationTarget);
    await writePlannedChange(change);
    return change;
  });
}

async function prepareOperationTargets(cwd: string, operations: readonly UniversalPatchOperation[]): Promise<OperationTarget[]> {
  const operationTargets: OperationTarget[] = [];
  for (const operation of operations) {
    operationTargets.push(await prepareOperationTarget(cwd, operation));
  }
  rejectDuplicateResolvedTargets(operationTargets);
  return operationTargets;
}

async function prepareOperationTarget(cwd: string, operation: UniversalPatchOperation): Promise<OperationTarget> {
  const targetPath = operation.kind === "add"
    ? await resolveNewTextFileTarget(cwd, operation.path)
    : await resolveExistingRealPath(cwd, operation.path);
  return { operation, targetPath };
}

async function planFileChanges(operationTargets: readonly OperationTarget[]): Promise<PlannedFileChange[]> {
  const plannedChanges: PlannedFileChange[] = [];
  for (const operationTarget of operationTargets) {
    plannedChanges.push(await planFileChange(operationTarget));
  }
  return plannedChanges;
}

async function planFileChangesForDryRun(cwd: string, operations: readonly UniversalPatchOperation[]): Promise<PlannedFileChange[]> {
  const plannedChanges: PlannedFileChange[] = [];
  const virtualFiles = new Map<string, DryRunFileState>();

  for (const operation of operations) {
    const targetPath = await resolveDryRunTargetPath(cwd, operation);
    const change = await planFileChangeForDryRun({ operation, targetPath }, virtualFiles);
    plannedChanges.push(change);
    updateDryRunFileState(virtualFiles, change);
  }

  return plannedChanges;
}

async function resolveDryRunTargetPath(cwd: string, operation: UniversalPatchOperation): Promise<string> {
  if (operation.kind !== "add") {
    const existingPath = await resolveExistingRealPath(cwd, operation.path).catch(() => undefined);
    if (existingPath) {
      return existingPath;
    }
  }
  return resolvePathThroughExistingParent(cwd, operation.path);
}

async function resolvePathThroughExistingParent(cwd: string, inputPath: string): Promise<string> {
  const absolutePath = resolveToolPath(cwd, inputPath);
  const realParentDirectory = await realpath(dirname(absolutePath)).catch(() => {
    throw new FileTextError(`Parent directory not found: ${dirname(absolutePath)}`);
  });
  return resolve(realParentDirectory, basename(absolutePath));
}

async function planFileChangeForDryRun(operationTarget: OperationTarget, virtualFiles: Map<string, DryRunFileState>): Promise<PlannedFileChange> {
  const { operation, targetPath } = operationTarget;
  const state = virtualFiles.get(targetPath);

  if (operation.kind === "add") {
    await assertDryRunNewTarget(targetPath, state);
    const newText = serializeAddFileText(operation);
    return {
      operation: "add",
      patchPath: operation.path,
      targetPath,
      newText,
      addedHashes: operation.lines.map(hashLine),
      warnings: buildInsertWarnings(operation)
    };
  }

  const oldText = await readDryRunExistingText(targetPath, state);
  if (operation.kind === "delete") {
    return { operation: "delete", patchPath: operation.path, targetPath, oldText, newText: undefined };
  }

  const applyResult = applyPatchToText(oldText, operation.patch);
  return { operation: "update", patchPath: operation.path, targetPath, oldText, newText: applyResult.text, applyResult, warnings: buildInsertWarnings(operation) };
}

async function assertDryRunNewTarget(targetPath: string, state: DryRunFileState | undefined): Promise<void> {
  if (state?.exists) {
    throw new FileTextError(`Add File target already exists: ${targetPath}`);
  }
  if (!state) {
    await assertNewTextFileTarget(targetPath);
    return;
  }
  await access(dirname(targetPath), constants.R_OK | constants.W_OK | constants.X_OK).catch(() => {
    throw new FileTextError(`Directory is not readable and writable: ${dirname(targetPath)}`);
  });
}

async function readDryRunExistingText(targetPath: string, state: DryRunFileState | undefined): Promise<string> {
  if (state) {
    if (!state.exists) {
      throw new FileTextError(`File not found: ${targetPath}`);
    }
    return state.text ?? "";
  }
  const { text } = await readExistingTextFile(targetPath, { writable: true });
  return text;
}

function updateDryRunFileState(virtualFiles: Map<string, DryRunFileState>, change: PlannedFileChange): void {
  if (change.operation === "delete") {
    virtualFiles.set(change.targetPath, { exists: false });
    return;
  }
  virtualFiles.set(change.targetPath, { exists: true, text: change.newText ?? "" });
}

async function writeRetryPatch(operations: readonly UniversalPatchOperation[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-locator-patch-"));
  const retryPatchPath = join(directory, "retry.patch");
  await writeRawFile(retryPatchPath, serializeUniversalPatch(operations), { encoding: "utf8", mode: 0o600, flag: "wx" });
  return retryPatchPath;
}


function renderSequentialFailureMessage(args: {
  appliedChanges: readonly PlannedFileChange[];
  failedOperation: UniversalPatchOperation;
  skippedOperations: readonly UniversalPatchOperation[];
  retryPatchPath: string;
  cause: unknown;
}): string {
  const sections = [
    `Patch stopped after ${args.appliedChanges.length} applied operation${args.appliedChanges.length === 1 ? "" : "s"}.`,
    "Applied:",
    renderAppliedOperationList(args.appliedChanges),
    "Failed:",
    `${renderOperationHeader(args.failedOperation)}\n${formatCause(args.cause)}`,
    "Skipped:",
    renderOperationList(args.skippedOperations),
    `Retry patch: ${args.retryPatchPath}`
  ];
  return sections.join("\n");
}

function renderAppliedOperationList(changes: readonly PlannedFileChange[]): string {
  if (changes.length === 0) {
    return "(none)";
  }
  return changes.map((change) => `*** ${capitalizeOperation(change.operation)} File: ${change.patchPath}`).join("\n");
}

function renderOperationList(operations: readonly UniversalPatchOperation[]): string {
  if (operations.length === 0) {
    return "(none)";
  }
  return operations.map(renderOperationHeader).join("\n");
}

function renderOperationHeader(operation: UniversalPatchOperation): string {
  return `*** ${capitalizeOperation(operation.kind)} File: ${operation.path}`;
}

function capitalizeOperation(operation: UniversalPatchOperation["kind"]): "Add" | "Update" | "Delete" {
  if (operation === "add") return "Add";
  if (operation === "update") return "Update";
  return "Delete";
}

function formatCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function buildPatchToolResult(plannedChanges: readonly PlannedFileChange[], dryRun: boolean) {
  const receipt = buildPatchReceiptDecision(plannedChanges, dryRun);
  const warnings = plannedChanges.flatMap((change) => change.warnings ?? []);
  return {
    content: [{ type: "text" as const, text: receipt.text }],
    details: {
      dryRun,
      diff: renderPatchTranscriptDiffs(plannedChanges.map(toDiffInput)),
      files: plannedChanges.map((change) => ({
        path: change.targetPath,
        patchPath: change.patchPath,
        operation: change.operation,
        lineCount: change.operation === "delete" ? 0 : parseText(change.newText ?? "").lines.length,
        receipt: change.applyResult
          ? {
              hashLineCount: change.applyResult.receiptHashLineCount,
              hunkReceipts: change.applyResult.hunkReceipts
            }
          : undefined,
        audit: change.applyResult ? { hunkAudits: change.applyResult.hunkAudits } : undefined
      })),
      receipt: {
        omitted: receipt.omitted,
        omitReason: receipt.omitReason,
        overflow: receipt.overflow,
        visibleLineCount: receipt.visibleLineCount
      },
      warnings
    }
  };
}

async function planFileChange(operationTarget: OperationTarget): Promise<PlannedFileChange> {
  const { operation, targetPath } = operationTarget;
  if (operation.kind === "add") {
    const newText = serializeAddFileText(operation);
    await assertNewTextFileTarget(targetPath);
    return {
      operation: "add",
      patchPath: operation.path,
      targetPath,
      newText,
      addedHashes: operation.lines.map(hashLine),
      warnings: buildInsertWarnings(operation)
    };
  }

  await assertExistingTextFileMutationTarget(targetPath);
  const { text: oldText } = await readExistingTextFile(targetPath, { writable: true });

  if (operation.kind === "delete") {
    return { operation: "delete", patchPath: operation.path, targetPath, oldText, newText: undefined };
  }

  const applyResult = applyPatchToText(oldText, operation.patch);
  return { operation: "update", patchPath: operation.path, targetPath, oldText, newText: applyResult.text, applyResult, warnings: buildInsertWarnings(operation) };
}

async function writePlannedChange(change: PlannedFileChange): Promise<void> {
  if (change.operation === "add") {
    await writeNewTextFileAtomically(change.targetPath, change.newText ?? "");
  } else if (change.operation === "update") {
    await writeTextFileAtomically(change.targetPath, change.newText ?? "");
  } else {
    await deleteExistingRegularFile(change.targetPath);
  }
}

function rejectDuplicateResolvedTargets(operationTargets: readonly OperationTarget[]): void {
  const seen = new Map<string, UniversalPatchOperation>();
  for (const { operation, targetPath } of operationTargets) {
    const existing = seen.get(targetPath);
    if (existing) {
      throw new InvalidPatchError(`Multiple operations resolve to the same target: ${existing.path} and ${operation.path}`);
    }
    seen.set(targetPath, operation);
  }
}

function serializeAddFileText(operation: AddFileOperation): string {
  return serializeText({
    bom: false,
    finalNewline: operation.finalNewline,
    lines: operation.lines,
    newline: "\n"
  });
}


function buildPatchReceiptDecision(plannedChanges: readonly PlannedFileChange[], dryRun: boolean): PatchReceiptDecision {
  const renderedReceipt = renderUniversalPatchReceipt(plannedChanges);
  const renderedWarnings = renderPatchWarnings(plannedChanges);
  const action = dryRun ? "Patch dry-run succeeded" : "Patch applied";
  if (renderedReceipt.length === 0) {
    const text = joinVisibleSections(renderedWarnings, `${action}. Receipt omitted: no visible hash receipt.`);
    return {
      text,
      omitted: true,
      omitReason: "empty",
      visibleLineCount: countRenderedLines(text)
    };
  }

  const visibleText = joinVisibleSections(renderedWarnings, renderedReceipt);
  const visibleLineCount = countRenderedLines(visibleText);
  const overflow = getVisibleOutputOverflow(visibleText, visibleLineCount);
  if (overflow) {
    const text = joinVisibleSections(renderedWarnings, `${action}. Receipt omitted: ${overflow.actual} exceeds visible cap ${overflow.max}.`);
    return {
      text,
      omitted: true,
      omitReason: "too_large",
      overflow,
      visibleLineCount: countRenderedLines(text)
    };
  }

  return {
    text: visibleText,
    omitted: false,
    visibleLineCount
  };
}

function buildInsertWarnings(operation: UniversalPatchOperation): string[] {
  const suspiciousCount = countHashlikeInsertLines(operation);
  if (suspiciousCount === 0) return [];
  const plural = suspiciousCount === 1 ? "" : "s";
  const verb = suspiciousCount === 1 ? "looks" : "look";
  return [
    `Warning: ${suspiciousCount} insert line${plural} in ${operation.path} ${verb} like a locator. ` +
      "Insert lines are literal content. Do not include hashes in `+` lines unless those hash characters are intended file content."
  ];
}

function countHashlikeInsertLines(operation: UniversalPatchOperation): number {
  if (operation.kind === "delete") return 0;
  const insertedLines = operation.kind === "add"
    ? operation.lines
    : operation.patch.hunks.flatMap((hunk) => hunk.ops.flatMap((op) => op.kind === "insert" ? [op.content] : []));
  return insertedLines.filter(looksLikeHashline).length;
}

function looksLikeHashline(value: string): boolean {
  const separatorIndex = value.indexOf(HASH_SEPARATOR);
  if (separatorIndex < 0) return false;
  return isHash(value.slice(0, separatorIndex));
}

function renderPatchWarnings(plannedChanges: readonly PlannedFileChange[]): string {
  return plannedChanges.flatMap((change) => change.warnings ?? []).join("\n");
}

function joinVisibleSections(...sections: readonly string[]): string {
  return sections.filter((section) => section.length > 0).join("\n");
}

function renderUniversalPatchReceipt(plannedChanges: readonly PlannedFileChange[]): string {
  return plannedChanges.map(renderFileReceipt).filter((text) => text.length > 0).join("\n");
}

function renderFileReceipt(change: PlannedFileChange): string {
  if (change.operation === "add") {
    return [`*** Add File: ${change.patchPath}`, ...(change.addedHashes ?? []).map((hash) => `+${hash}`)].join("\n");
  }
  if (change.operation === "delete") {
    return [`*** Delete File: ${change.patchPath}`, "Deleted file"].join("\n");
  }
  if (!change.applyResult || change.applyResult.receiptHashLineCount === 0) {
    return "";
  }
  return [`*** Update File: ${change.patchPath}`, change.applyResult.renderedReceipt].join("\n");
}

function toDiffInput(change: PlannedFileChange): PatchTranscriptDiffInput {
  return {
    kind: change.operation,
    path: change.patchPath,
    oldText: change.oldText,
    newText: change.newText,
    applyResult: change.applyResult
  };
}

function withMutationQueues<T>(paths: readonly string[], callback: () => Promise<T>): Promise<T> {
  const [firstPath, ...remainingPaths] = paths;
  if (!firstPath) {
    return callback();
  }
  return withFileMutationQueue(firstPath, () => withMutationQueues(remainingPaths, callback));
}
