import { constants } from "node:fs";
import { access, mkdtemp, realpath, writeFile as writeRawFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyPatchToText, type ApplyPatchResult } from "../apply.js";
import { readLocatorPatchConfig } from "../config.js";
import { renderPatchHashReceiptDiffs, renderPatchTranscriptDiffs, type PatchTranscriptDiffInput } from "../content-diff.js";
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
import { countRenderedLines, getVisibleOutputOverflow, type VisibleOutputOverflow } from "../output-size.js";
import { parseText, serializeText } from "../text-lines.js";
import { parsePatchInput, serializeUniversalPatch, type AddFileOperation, type UniversalPatchOperation } from "../universal-patch-format.js";
import { buildPatchCallRenderText, buildPatchResultRenderText, getPatchResultText } from "./patch-render.js";
import { dedentBlock } from "../dedent.js";

const PATCH_PARAMETER_DESCRIPTION = dedentBlock(`
  <description>
  Inline patch text. Mutually exclusive with \`patch_file\`.
  ## Wrappers
  Patch must start with \`*** Begin Patch\` and end with \`*** End Patch\`.
  ## File Sections
  A patch may contain multiple \`*** Add File\`, \`*** Update File\`, and \`*** Delete File\` sections;
  A file section header includes a file path.
  e.g. \`*** Add File: path/to/file.txt\`
  ### Add File
  \`Add File\` sections contain body rows only: \`+<text>\`. They do not use \`@@\` hunks.
  ## Hunk Sections
  Each \`Update File\` section may contain multiple \`@@\` hunks.
  Hunk headers are \`@@\`.
  ### Line Anchor
  A line anchor can be appended to a hunk header.
  Line number is 1-based.
  A hunk with a line anchor looks like: \`@@ @<start>\`, or \`@@ @<start>...<end>\`;
  \`@@ @<start>\` starts searching at 1-based line \`<start>\` and requires the resolved match start to be at or after that line, while \`@@ @<start>...<end>\` requires the resolved match span to stay within inclusive 1-based line range [start, end].
  ### Hunk Match
  A hunk can contain line matchers.
  The syntax for line matcher is \`<operator><locator_marker>[<locator_value>]\`.
  Line matches in a hunk section are grouped to form a hunk match.
  #### Match Operators
  Match operator (\`<operator>\`) can be either "-" or a literal space " ".
  It is the first char of the line matcher.
  It cannot be omitted;
  "-" operator is used to delete the matched line.
  space operator is a context-only noop for matching/anchoring only.
  #### Locators
  A locator identifies lines for context or deletion.
  It always starts with a \`<locator_marker>\` and optionally a \`<locator_value>\`.
  ##### Locator Markers
  A \`<locator_marker>\` is used to specify the type of locator.
  "^" specifies a prefix locator.
  ":" specifies an exact text locator.
  "$" specifies a suffix locator.
  "*" specifies a contains locator.
  "#" specifies a hash locator.
  "?" specifies a combined locator.
  "..." specifies a range locator.
  ##### Locator Values
  \`^<prefix>\` matches by prefix string.
  \`:<text>\` matches exact raw line text.
  \`$<suffix>\` matches by suffix string.
  \`*<text>\` matches by testing if a line contains the \`<text>\` value.
  \`#<hash>\` matches by line hash value; use hash-line \`read\` in hash mode, or prior patch receipts/trusted context, to get current hashes.
  \`?<json-obj>\` is a combined locator.
  \`...\` is a range locator; it has no \`<locator_value>\`.
  e.g. \` ^<prefix>\` means prefix context match; \`-^<prefix>\` means prefix delete match.
  ##### Range Locator
  A range locator has to be used in-between other line matchers.
  e.g. \` ...\` preserves/skips lines between surrounding matchers; \`-...\` deletes lines between surrounding matchers.
  ##### Combined Locator
  A combined locator uses a JSON object to specify locators to combine.
  Currently, "prefix", "suffix", "contains" are the allowed locator keys.
  "contains" key can be mapped to a string or an array of strings.
  The JSON object must contain at least one key.
  e.g. \`{"prefix":"a","contains":["b","c"],"suffix":"d"}\`
  ### Insertion
  Patch uses a leading "+" operator to insert lines.
  The "+" char needs to be the first char of the line.
  The syntax is \`+<text>\`, where \`<text>\` is a raw string for a line content.
  Only hunk sections or \`Add File\` sections are allowed to insert lines.
  </description>

  <policy>
  <important>Token efficiency is the highest priority.</important>
  Use patch locators when target/context lines are long enough that shortened prefix/suffix/contains saves more than patch locator marker cost — roughly >10 chars or >2 words. For tiny unique lines, exact-text/unified-diff may be cheaper.
  Use hash locators when a hash is already known for a line.
  Use the shortest prefix/suffix/contains locator that uniquely identifies the target line in its hunk context.
  Use range locator whenever possible for hunks > 3 lines.
  Use line anchors to disambiguate only if the latest accurate line offset is available or add extra redundancy to the anchors.
  Avoid exact text locators and unified-diff format unless for very short lines, or when necessary to disambiguate hunk matches.
  Increasing the hunk context range with shorter locators for unambiguous anchoring is usually more efficient than using exact text matches or unified-diff for long lines.
  If the tool returns a retry patch file containing large chunks of unapplied operations due to failures. Try fixing the retry patch file and passing it via \`patch_file\` instead of re-emitting large patch text to save tokens.
  </policy>
  
  <caveats>
  Locator rows are preferred, but malformed unified-diff muscle memory is tolerated.
  A context/delete row without a locator marker is parsed as unified diff: text after \` \`, or \`-\` is exact line content.
  Only \`Update File\` section can have hunk match.
  </caveats>

  <examples>
    <example description="patch locator efficiency">
      <content>
      aaaaaaaaaab
      aaaaacaaaaa
      bbbbbbbbbba
      </content>
      <desired_content>
      aaaaacaaaaa
      new text
      </desired_content>
      <bad_patch_snippet>
      -:aaaaaaaaaab
       aaaaacaaaaa
      -bbbbbbbbbba
      +new text
      </bad_patch_snippet>
      <explanation>
      Exact text match works, but is unnecessarily costly in this case.
      Should use shorter locators like prefix or suffix locators.
      </explanation>
      <patch>
      *** Begin Patch
      *** Update File: path/to/file.txt
      @@
      -$b
       *c
      -^b
      +new text
      *** End Patch
      </patch>
      <explanation>
      "$b" locates first line that ends with "b".
      "*c" locates the second line that contains "c".
      In this example, " ..." could replace " *c" to preserve the middle line.
      "^b" locates the third line starts with "b".
      no need for exact match.
      </explanation>
    </example>
    <example description="blank line operations">
      <content>
      before


      after
      </content>
      <patch description="delete one blank line and insert one at the end">
      *** Begin Patch
      *** Update File: path/to/file.txt
      @@
       :before
       :
      -:
       :after
      +
      *** End Patch
      </patch>
      <explanation>
      use " :" to match a blank context line, "-:" to delete a blank line, and "+" with no following text to insert a blank line.
      </explanation>
    </example>
    <example description="range selection">
      <content>
      aaa
      bbb
      ccc
      ddd
      eee
      fff
      </content>
      <bad_patch_snippet>
      -aaa
      -bbb
      -ccc
      -ddd
      -eee
      -fff
      </bad_patch_snippet>
      <explanation>
      works but waste tokens on unnecessary locators.
      range selection is enough to target the hunk.
      </explanation>
      <good_patch_snippet description="bulk delete all">
      -^a
      -...
      -^f
      </good_patch_snippet>
      <explanation>
      find a hunk with first line starts with "a" and last line starts with "f".
      delete the first line and last line.
      delete lines in-between first and last line using range locator.
      </explanation>
    </example>
    <example description="disambiguate from duplicate lines">
      <content>
      aaa
      aaa
      ccc
      ccc
      </content>
      <bad_patch_snippet>
      aaa
      +bbb
      </bad_patch_snippet>
      <explanation>
      "aaa" is invalid, it does not have an operator as the first char.
      </explanation>
      <ok_patch_snippet>
      @@ @2
       ^a
      +bbb
      </ok_patch_snippet>
      <explanation>
      use line anchor "@2" to search at or after line 2.
      so it can locate the only match for "aaa" at line 2.
      similarly, we can use "@2...2" to pin the line range to [2,2].
      then insert a new line after.
      </explanation>
      <caveat>
      use line anchors with cautiousness, any previous change might have shifted the line numbers.
      do not use stale line numbers as anchor unless add redundancy on the anchors.
      </caveat>
      <good_patch_snippet>
       ^a
      +bbb
       ^c
      </good_patch_snippet>
      <explanation>
      find a hunk with adjacent "aaa" and "ccc" lines.
      insert a new line "bbb" in-between.
      </explanation>
    </example>
    <example description="unified-diff edge cases">
      <content>
      :leading colon
      </content>
      <bad_patch_snippet>
      -:leading colon
      </bad_patch_snippet>
      <explanation>
      "-:" is treated as exact text locator instead of unified-diff to match the text "leading colon", missing the first ":".
      There is no way to use unified-diff format to match leading ":".
      </explanation>
      <good_patch_snippet>
      -::leading colon
      </good_patch_snippet>
    </example>
  </examples>
`);

interface PatchStatusDecision {
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
}

interface PatchCharEfficiency {
  patchChars: number;
  baselineChars: number;
}

interface DryRunFileState {
  exists: boolean;
  text?: string;
}

export const patchTool = defineTool({
  name: "patch",
  label: "Locator Patch",
  description: "Token-efficient tool for editing files with multi-file-capable add/update/delete patches.",
  promptSnippet: "Use this tool for patching.",
  promptGuidelines: buildPatchPromptGuidelines(false),
  parameters: Type.Object(
    {
      patch: Type.Optional(
        Type.String({
          description: PATCH_PARAMETER_DESCRIPTION
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
    const universalPatch = await parsePatchInputWithRetryPatch(patchText);
    const dryRun = params.dry_run ?? false;

    if (dryRun) {
      return buildPatchToolResult(await planFileChangesForDryRun(ctx.cwd, universalPatch.operations), true, await isHashModeEnabled(ctx));
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

    return buildPatchToolResult(plannedChanges, false, await isHashModeEnabled(ctx));
  },
  renderCall(_args, theme, context) {
    return new Text(
      buildPatchCallRenderText({
        input: context.args,
        expanded: context.expanded,
        argsComplete: context.argsComplete,
        theme
      }),
      0,
      0
    );
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
        errorInput: context.args,
        theme
      }),
      0,
      0
    );
  }
});

export function setPatchToolHashModeGuideline(hashMode: boolean): void {
  patchTool.promptGuidelines = buildPatchPromptGuidelines(hashMode);
}

function buildPatchPromptGuidelines(hashMode: boolean): string[] {
  const guidelines = [
    "Prefer `patch` tool over other text-replacement-based editing.",
  ];
  if (hashMode) {
    guidelines.push("Hash mode active: use `read` for hash-line text reads; `patch` success returns a compact hash-only receipt with context hashes, inserted-line hashes. Treat patch receipt as current state for touched hunks. Reuse known hashes prior `read` and prior patch receipts to avoid unnecessary read.");
  }
  return guidelines;
}

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

async function parsePatchInputWithRetryPatch(patchText: string) {
  try {
    return parsePatchInput(patchText);
  } catch (error) {
    if (!(error instanceof InvalidPatchError)) {
      throw error;
    }
    const retryPatchPath = await writeRawRetryPatch(patchText);
    const retryableError = new InvalidPatchError(`${error.detail}\nRetry patch: ${retryPatchPath}`, error.location);
    Object.assign(retryableError, { retryPatchPath });
    throw retryableError;
  }
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
      newText
    };
  }

  const oldText = await readDryRunExistingText(targetPath, state);
  if (operation.kind === "delete") {
    return { operation: "delete", patchPath: operation.path, targetPath, oldText, newText: undefined };
  }

  const applyResult = applyPatchToText(oldText, operation.patch);
  return { operation: "update", patchPath: operation.path, targetPath, oldText, newText: applyResult.text, applyResult };
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

async function writeRawRetryPatch(patchText: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-locator-patch-"));
  const retryPatchPath = join(directory, "retry.patch");
  await writeRawFile(retryPatchPath, patchText, { encoding: "utf8", mode: 0o600, flag: "wx" });
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

async function isHashModeEnabled(_ctx: { cwd: string }): Promise<boolean> {
  return (await readLocatorPatchConfig()).hashMode;
}

function buildPatchToolResult(plannedChanges: readonly PlannedFileChange[], dryRun: boolean, hashMode: boolean) {
  const status = buildPatchStatusDecision(plannedChanges, dryRun, hashMode);
  return {
    content: [{ type: "text" as const, text: status.text }],
    details: {
      dryRun,
      diff: renderPatchTranscriptDiffs(plannedChanges.map(toDiffInput)),
      files: plannedChanges.map((change) => ({
        path: change.targetPath,
        patchPath: change.patchPath,
        operation: change.operation,
        lineCount: change.operation === "delete" ? 0 : parseText(change.newText ?? "").lines.length,
        audit: change.applyResult ? { hunkAudits: change.applyResult.hunkAudits } : undefined
      })),
      status: {
        omitted: status.omitted,
        omitReason: status.omitReason,
        overflow: status.overflow,
        visibleLineCount: status.visibleLineCount
      },
      charEfficiency: getPatchCharEfficiency(plannedChanges)
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
      newText
    };
  }

  await assertExistingTextFileMutationTarget(targetPath);
  const { text: oldText } = await readExistingTextFile(targetPath, { writable: true });

  if (operation.kind === "delete") {
    return { operation: "delete", patchPath: operation.path, targetPath, oldText, newText: undefined };
  }

  const applyResult = applyPatchToText(oldText, operation.patch);
  return { operation: "update", patchPath: operation.path, targetPath, oldText, newText: applyResult.text, applyResult };
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

function getPatchCharEfficiency(plannedChanges: readonly PlannedFileChange[]): PatchCharEfficiency {
  return plannedChanges.reduce(
    (total, change) => {
      const changeEfficiency = getFileChangeCharEfficiency(change);
      return {
        patchChars: total.patchChars + changeEfficiency.patchChars,
        baselineChars: total.baselineChars + changeEfficiency.baselineChars
      };
    },
    { patchChars: 0, baselineChars: 0 }
  );
}

function getFileChangeCharEfficiency(change: PlannedFileChange): PatchCharEfficiency {
  if (change.operation === "add") {
    const chars = prefixedTextLinesCharCount(change.newText ?? "");
    return { patchChars: chars, baselineChars: chars };
  }
  if (change.operation === "delete") {
    return { patchChars: 0, baselineChars: prefixedTextLinesCharCount(change.oldText ?? "") };
  }

  const hunkAudits = change.applyResult?.hunkAudits ?? [];
  return hunkAudits.reduce(
    (total, hunkAudit) => ({
      patchChars: total.patchChars + hunkAudit.patchCharCount,
      baselineChars: total.baselineChars + hunkAudit.baselineCharCount
    }),
    { patchChars: 0, baselineChars: 0 }
  );
}

function prefixedTextLinesCharCount(text: string): number {
  return parseText(text).lines.reduce((total, line) => total + line.length + 1, 0);
}


function buildPatchStatusDecision(plannedChanges: readonly PlannedFileChange[], dryRun: boolean, hashMode: boolean): PatchStatusDecision {
  const visibleText = hashMode ? renderPatchHashReceiptDiffs(plannedChanges.map(toDiffInput)) : renderUniversalPatchStatus(plannedChanges, dryRun);
  const visibleLineCount = countRenderedLines(visibleText);
  const overflow = getVisibleOutputOverflow(visibleText, visibleLineCount);
  if (overflow) {
    const text = renderUniversalPatchStatus(plannedChanges, dryRun);
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


function renderUniversalPatchStatus(plannedChanges: readonly PlannedFileChange[], dryRun: boolean): string {
  return plannedChanges.map((change) => renderFileStatus(change, dryRun)).join("\n");
}

function renderFileStatus(change: PlannedFileChange, dryRun: boolean): string {
  const status = dryRun ? "Validated" : change.operation === "delete" ? "Deleted file" : "Applied";
  return [`*** ${capitalizeOperation(change.operation)} File: ${change.patchPath}`, status].join("\n");
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
