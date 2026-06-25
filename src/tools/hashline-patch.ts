import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyPatchToText, type ApplyPatchResult } from "../apply.js";
import { renderUnifiedContentDiffs, type FileContentDiffInput } from "../content-diff.js";
import { InvalidPatchError } from "../errors.js";
import {
  assertExistingTextFileMutationTarget,
  assertNewTextFileTarget,
  deleteExistingRegularFile,
  readExistingTextFile,
  resolveExistingRealPath,
  resolveNewTextFileTarget,
  writeNewTextFileAtomically,
  writeTextFileAtomically
} from "../fs-text.js";
import { hashLine } from "../hash.js";
import { countRenderedLines, getVisibleOutputOverflow, type VisibleOutputOverflow } from "../output-size.js";
import { parseText, serializeText } from "../text-lines.js";
import { parsePatchInput, type AddFileOperation, type UniversalPatchOperation } from "../universal-patch-format.js";
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
}

export const patchTool = defineTool({
  name: "patch",
  label: "Hashline Patch",
  description: "Apply a Codex-like multi-file hashline patch with Add File, Update File, and Delete File sections.",
  promptSnippet: "patch accepts *** Begin Patch / *** Add File / *** Update File / *** Delete File / *** End Patch; updates use hash-only context/delete anchors from read plus literal inserted lines.",
  promptGuidelines: [
    "Prefer universal patch input: '*** Begin Patch', one or more file operation headers, then '*** End Patch'.",
    "Add File body lines are literal new file content prefixed with '+'. Target file must not already exist. Visible receipt shows only '*** Add File: path' and '+HASH' rows.",
    "Update File sections use Codex-style '@@' hunks. Context/delete lines are hash-only (' HHHH', '-HHHH'); insert lines are literal content ('+new text'). Do not paste HASH│content rows into patch operations.",
    "Update matching uses only context/delete hash sequences. Do not use line numbers, duplicate counters, fuzzy fallback, or legacy replace fields.",
    "Delete File sections match Codex behavior: use only the file header and no body. The tool hard-deletes the resolved regular file after validation; visible output exposes no deleted content.",
    "On success, visible output is a compact hash-only receipt/status. Full content diff is available only in details.diff for the host/UI."
  ],
  parameters: Type.Object(
    {
      patch: Type.String({ description: "Codex-like multi-file patch text." }),
      dry_run: Type.Optional(Type.Boolean({ description: "Validate/apply in memory and do not write." }))
    },
    { additionalProperties: false }
  ),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (signal?.aborted) {
      throw new Error("Cancelled");
    }

    const universalPatch = parsePatchInput(params.patch);
    const operationTargets = await prepareOperationTargets(ctx.cwd, universalPatch.operations);
    const queuePaths = operationTargets.map((target) => target.targetPath).sort();

    return withMutationQueues(queuePaths, async () => {
      const plannedChanges = await planFileChanges(operationTargets);
      const dryRun = params.dry_run ?? false;
      if (!dryRun) {
        for (const change of plannedChanges) {
          if (change.operation === "add") {
            await writeNewTextFileAtomically(change.targetPath, change.newText ?? "");
          } else if (change.operation === "update") {
            await writeTextFileAtomically(change.targetPath, change.newText ?? "");
          } else {
            await deleteExistingRegularFile(change.targetPath);
          }
        }
      }

      const receipt = buildPatchReceiptDecision(plannedChanges, dryRun);
      return {
        content: [{ type: "text", text: receipt.text }],
        details: {
          dryRun,
          diff: renderUnifiedContentDiffs(plannedChanges.map(toDiffInput)),
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
          }
        }
      };
    });
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

async function prepareOperationTargets(cwd: string, operations: readonly UniversalPatchOperation[]): Promise<OperationTarget[]> {
  const operationTargets: OperationTarget[] = [];
  for (const operation of operations) {
    const targetPath = operation.kind === "add"
      ? await resolveNewTextFileTarget(cwd, operation.path)
      : await resolveExistingRealPath(cwd, operation.path);
    operationTargets.push({ operation, targetPath });
  }
  rejectDuplicateResolvedTargets(operationTargets);
  return operationTargets;
}

async function planFileChanges(operationTargets: readonly OperationTarget[]): Promise<PlannedFileChange[]> {
  const plannedChanges: PlannedFileChange[] = [];
  for (const operationTarget of operationTargets) {
    const { operation, targetPath } = operationTarget;
    if (operation.kind === "add") {
      const newText = serializeAddFileText(operation);
      await assertNewTextFileTarget(targetPath);
      plannedChanges.push({ operation: "add", patchPath: operation.path, targetPath, newText, addedHashes: operation.lines.map(hashLine) });
      continue;
    }

    await assertExistingTextFileMutationTarget(targetPath);
    const { text: oldText } = await readExistingTextFile(targetPath, { writable: true });

    if (operation.kind === "delete") {
      plannedChanges.push({ operation: "delete", patchPath: operation.path, targetPath, oldText, newText: undefined });
      continue;
    }

    const applyResult = applyPatchToText(oldText, operation.patch);
    plannedChanges.push({ operation: "update", patchPath: operation.path, targetPath, oldText, newText: applyResult.text, applyResult });
  }
  return plannedChanges;
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
  const action = dryRun ? "Patch dry-run succeeded" : "Patch applied";
  if (renderedReceipt.length === 0) {
    return {
      text: `${action}. Receipt omitted: no visible hash receipt. Use read to inspect current file hashes.`,
      omitted: true,
      omitReason: "empty",
      visibleLineCount: 1
    };
  }

  const visibleLineCount = countRenderedLines(renderedReceipt);
  const overflow = getVisibleOutputOverflow(renderedReceipt, visibleLineCount);
  if (overflow) {
    return {
      text: `${action}. Receipt omitted: ${overflow.actual} exceeds visible cap ${overflow.max}. Use read to inspect current file hashes.`,
      omitted: true,
      omitReason: "too_large",
      overflow,
      visibleLineCount
    };
  }

  return {
    text: renderedReceipt,
    omitted: false,
    visibleLineCount
  };
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

function toDiffInput(change: PlannedFileChange): FileContentDiffInput {
  return {
    kind: change.operation,
    path: change.patchPath,
    oldText: change.oldText,
    newText: change.newText
  };
}

function withMutationQueues<T>(paths: readonly string[], callback: () => Promise<T>): Promise<T> {
  const [firstPath, ...remainingPaths] = paths;
  if (!firstPath) {
    return callback();
  }
  return withFileMutationQueue(firstPath, () => withMutationQueues(remainingPaths, callback));
}
