import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyPatchToText, type ApplyPatchResult } from "../apply.js";
import { renderUnifiedContentDiffs, type FileContentDiffInput } from "../content-diff.js";
import { InvalidPatchError } from "../errors.js";
import {
  assertNewTextFileTarget,
  deleteExistingRegularFile,
  readExistingTextFile,
  resolveExistingRealPath,
  resolveToolPath,
  writeNewTextFileAtomically,
  writeTextFileAtomically
} from "../fs-text.js";
import { hashLine } from "../hash.js";
import { countRenderedLines, getVisibleOutputOverflow, type VisibleOutputOverflow } from "../output-size.js";
import { parseText } from "../text-lines.js";
import { parsePatchInput, type UniversalPatchOperation } from "../universal-patch-format.js";

interface PatchReceiptDecision {
  text: string;
  omitted: boolean;
  omitReason?: "empty" | "too_large";
  overflow?: VisibleOutputOverflow;
  visibleLineCount: number;
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
  promptSnippet: "patch accepts *** Begin Patch / *** Add File / *** Update File / *** Delete File / *** End Patch; updates use exact HASH│content anchors.",
  promptGuidelines: [
    "Prefer universal patch input: '*** Begin Patch', one or more file operation headers, then '*** End Patch'.",
    "Add File body lines are literal new file content prefixed with '+'. Target file must not already exist. Visible receipt shows only '*** Add File: path' and '+HASH' rows.",
    "Update File sections use '@@ @@' hunks and operation lines like ' HHHH│context', '-HHHH│old', '+HHHH│new'.",
    "Update matching uses only context/deletion hash sequences. Do not use line numbers, duplicate counters, fuzzy fallback, or legacy replace fields.",
    "Delete File sections require delete-only hashline hunks proving the complete current file content. The tool hard-deletes the resolved regular file after validation; visible output exposes no deleted content.",
    "On success, visible output is a compact hash-only receipt/status. Full content diff is available only in details.diff for the host/UI."
  ],
  parameters: Type.Object(
    {
      path: Type.Optional(Type.String({ description: "Legacy single-file target path; omit for universal patches with file headers." })),
      patch: Type.String({ description: "Codex-like multi-file patch text; legacy @@ @@ single-file patch is accepted when path is provided." }),
      dry_run: Type.Optional(Type.Boolean({ description: "Validate/apply in memory and do not write." }))
    },
    { additionalProperties: false }
  ),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (signal?.aborted) {
      throw new Error("Cancelled");
    }

    const universalPatch = parsePatchInput(params.patch, params.path);
    const queuePaths = [...new Set(universalPatch.operations.map((operation) => resolveToolPath(ctx.cwd, operation.path)))].sort();

    return withMutationQueues(queuePaths, async () => {
      const plannedChanges = await planFileChanges(ctx.cwd, universalPatch.operations);
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
  }
});

async function planFileChanges(cwd: string, operations: readonly UniversalPatchOperation[]): Promise<PlannedFileChange[]> {
  const plannedChanges: PlannedFileChange[] = [];
  for (const operation of operations) {
    if (operation.kind === "add") {
      const targetPath = resolveToolPath(cwd, operation.path);
      const newText = operation.lines.join("\n");
      await assertNewTextFileTarget(targetPath);
      plannedChanges.push({ operation: "add", patchPath: operation.path, targetPath, newText, addedHashes: operation.lines.map(hashLine) });
      continue;
    }

    const targetPath = await resolveExistingRealPath(cwd, operation.path);
    const { text: oldText } = await readExistingTextFile(targetPath, { writable: true });
    const applyResult = applyPatchToText(oldText, operation.patch);

    if (operation.kind === "delete") {
      assertDeletePatchRemovesWholeFile(operation.path, oldText, applyResult);
      plannedChanges.push({ operation: "delete", patchPath: operation.path, targetPath, oldText, newText: undefined, applyResult });
      continue;
    }

    plannedChanges.push({ operation: "update", patchPath: operation.path, targetPath, oldText, newText: applyResult.text, applyResult });
  }
  return plannedChanges;
}

function assertDeletePatchRemovesWholeFile(path: string, oldText: string, applyResult: ApplyPatchResult): void {
  const oldLineCount = parseText(oldText).lines.length;
  const deletedLineCount = applyResult.hunkAudits.reduce((count, audit) => count + audit.deletedHashes.length, 0);
  if (oldLineCount === 0) {
    throw new InvalidPatchError(`Delete File requires hashline evidence and cannot delete empty file without content evidence: ${path}`);
  }
  if (applyResult.text !== "" || deletedLineCount !== oldLineCount) {
    throw new InvalidPatchError(`Delete File evidence must cover the complete current file: ${path}`);
  }
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
