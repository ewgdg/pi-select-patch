import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  realpath,
  writeFile as writeRawFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  defineTool,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyPatchToText, type ApplyPatchResult } from "../apply.js";
import {
  readLocatorPatchConfig,
  type LocatorPatchConfig,
  type LocatorPatchProfile,
} from "../config.js";
import {
  renderPatchHashReceiptDiffs,
  renderPatchTranscriptDiffs,
  type PatchTranscriptDiffInput,
} from "../content-diff.js";
import {
  FileTextError,
  InvalidPatchError,
  PartialPatchError,
} from "../errors.js";
import {
  assertExistingTextFileMutationTarget,
  assertNewTextFileTarget,
  deleteExistingRegularFile,
  readExistingTextFile,
  resolveExistingRealPath,
  resolveToolPath,
  resolveNewTextFileTarget,
  writeNewTextFileAtomically,
  writeTextFileAtomically,
} from "../fs-text.js";
import { formatLocatorCostWarning, type PatchCharEfficiency } from "../locator-efficiency.js";
import {
  countRenderedLines,
  getVisibleOutputOverflow,
  type VisibleOutputOverflow,
} from "../output-size.js";
import { type ParsePatchOptions } from "../patch-format.js";
import { parseText, serializeText } from "../text-lines.js";
import {
  parsePatchInput,
  serializeUniversalPatch,
  type AddFileOperation,
  type UniversalPatchOperation,
} from "../universal-patch-format.js";
import {
  buildPatchCallRenderText,
  buildPatchResultRenderText,
  getPatchResultText,
} from "./patch-render.js";
import { dedentBlock } from "../dedent.js";

function buildPatchParameterDescription(profile: LocatorPatchProfile): string {
  const hunkMatchDescription = indentNonBlankLines(buildPatchHunkMatchDescription(profile), "    ");
  const profilePolicy = indentNonBlankLines(buildPatchProfilePolicy(profile), "    ");
  const examples = indentNonBlankLines(buildPatchParameterExamples(profile), "    ");
  return dedentBlock(`
    <description>
    Inline patch text. Mutually exclusive with \`patch_file\`.
    ## File Sections
    A patch may contain multiple \`*** Add File\`, \`*** Update File\`, and \`*** Delete File\` sections;
    a file section header includes a file path.
    e.g. \`*** Add File: path/to/file.txt\`
    ### Add File
    \`Add File\` sections contain body rows only: \`+<text>\`. They do not use \`@@\` hunks.
    ## Hunk Sections
    Each \`Update File\` section may contain multiple \`@@\` hunks.
    Within one \`Update File\` section, later hunks may match or span only untouched original target lines; they cannot anchor on or range across lines inserted or already used by earlier hunks. To make an edit depend on prior output, use a later \`*** Update File\` section for the same path.
    Hunk headers are \`@@\`.
    ### Line Anchor
    A line anchor can be appended to a hunk header.
    Line number is 1-based.
    Line anchors define the allowed 1-based match span: [start, +inf) for \`@@ @<start>\`, or [start, end] for \`@@ @<start>...<end>\`.
${hunkMatchDescription}
    ### Insertion
    Patch uses a leading "+" operator to insert lines.
    The "+" char must be first char of the line.
    The syntax is \`+<text>\`, where \`<text>\` is raw line content.
    Only hunk sections or \`Add File\` sections may insert lines.
    </description>

    <policy>
    <important>Token efficiency is the highest priority.</important>
${profilePolicy}
    <important>Use range locator whenever possible for hunks > 3 lines.</important>
    Use line anchors to disambiguate only if the latest accurate line offset is available or add extra redundancy to the anchors.
    If the tool returns a retry patch file containing large chunks of unapplied operations due to failures, fix the retry patch file and pass it via \`patch_file\` instead of re-emitting large patch text.
    </policy>

    <caveats>
    Only \`Update File\` sections can have hunk matches.
    </caveats>

    <examples>
${examples}
    </examples>
  `);
}

function indentNonBlankLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${indent}${line}`))
    .join("\n");
}

function buildPatchHunkMatchDescription(profile: LocatorPatchProfile): string {
  if (profile === "smart") {
    return dedentBlock(`
      ### Hunk Match: Smart Profile
      Context/delete rows use smart locators.
      Use plain text rows for context and \`-<text>\` rows for deletes. Use \`-\` to delete a blank line.
      Bare context rows may omit leading space.
      Smart rows resolve independently to exact, prefix, suffix, contains, or whitespace token-subsequence match; the whole hunk applies only with one dominance winner.
      Range rows are \`...\` for preserved/skipped context and \`-...\` for deleted ranges.
    `);
  }
  if (profile === "hash") {
    return dedentBlock(`
      ### Hunk Match: Hash Profile
      Context/delete rows identify lines by hash.
      Copy only the 1- to 4-character hash from \`HASH│content\` read output, not the separator or content.
      Use \`<hash>\` for context and \`-<hash>\` for deletes.
      Use only the hash characters from read output; omit \`#\`.
      Range rows are \`...\` for preserved/skipped context and \`-...\` for deleted ranges.
    `);
  }
  return dedentBlock(`
    ### Hunk Match: Classic Profile
    A hunk contains line matchers. Match operators are "-" for delete and literal space " " for context.
    Context locator rows may omit the leading space when the row starts with a locator marker.
    Locator markers:
    - \`^<prefix>\`: prefix match
    - \`:<text>\`: exact raw line match
    - \`$<suffix>\`: suffix match
    - \`*<text>\`: contains match
    - \`~<text>\`: smart match
    - \`#<hash>\`: hash match when hash locators are enabled by \`receipt: "hash"\`
    - \`?<json-obj>\`: combined locator with \`prefix\`, \`contains\`, and/or \`suffix\`
    - \`...\`: range row; use \`...\` for context range and \`-...\` for delete range
    If no locator marker follows the operator, classic profile uses exact unified-diff matching: \` text\` is exact context and \`-text\` is exact delete. Bare exact context text without leading space is invalid.
  `);
}

function buildPatchProfilePolicy(profile: LocatorPatchProfile): string {
  if (profile === "smart") {
    return "Prefer short smart rows. Include enough neighboring smart context or an anchor hint when text may repeat.";
  }
  if (profile === "hash") {
    return "Prefer the shortest unique hash width available from `read`. Use `...` ranges to avoid listing many unchanged/deleted hashes.";
  }
  return "Use partial-match-based locators when target/context lines are long enough that shortened prefix/suffix/contains saves more than patch locator marker cost. Use hash locators only when hash locators are enabled and a hash is already known. Use the shortest prefix/suffix/contains locator that uniquely identifies the target line in hunk context. Avoid exact text locators and unified-diff format unless needed to disambiguate hunk matches.";
}

function buildPatchParameterExamples(profile: LocatorPatchProfile): string {
  if (profile === "smart") {
    return dedentBlock(`
      <example description="smart replacement">
      <patch>
      *** Update File: path/to/file.txt
      @@
      stable anchor
      -old target words
      +new target words
      </patch>
      <explanation>
      Smart matching picks exact/prefix/suffix/contains/subsequence as needed.
      </explanation>
      </example>
      <example description="smart range deletion">
      <patch>
      *** Update File: path/to/file.txt
      @@
      start line
      -...
      end line
      </patch>
      <explanation>
      Smart context rows anchor the range. \`-...\` deletes all matched lines between them.
      </explanation>
      </example>
    `);
  }
  if (profile === "hash") {
    return dedentBlock(`
      <example description="hash replacement">
      <read_output>
      a│old
      b3│tail
      </read_output>
      <patch>
      *** Update File: path/to/file.txt
      @@
      -a
      +new
      b3
      </patch>
      <explanation>
      Hash profile rows use only the hash before \`│\`. Omit \`#\`.
      </explanation>
      </example>
      <example description="hash range deletion">
      <patch>
      *** Update File: path/to/file.txt
      @@
      a
      -...
      z9
      </patch>
      <explanation>
      \`a\` and \`z9\` are context hashes. \`-...\` deletes the range between them.
      </explanation>
      </example>
    `);
  }
  return dedentBlock(`
    <example description="patch locator cost efficiency">
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
    Exact text match works, but costs more than shorter locators.
    </explanation>
    <patch>
    *** Update File: path/to/file.txt
    @@
    -$b
     *c
    -^b
    +new text
    </patch>
    <explanation>
    \`$b\` matches a line ending with b. \`*c\` matches a line containing c. \`^b\` matches a line starting with b.
    </explanation>
    </example>
    <example description="blank line operations">
    <patch>
    *** Update File: path/to/file.txt
    @@
     :before
     :
    -:
     :after
    +
    </patch>
    <explanation>
    Use \` :\` to match a blank context line, \`-:\` to delete a blank line, and \`+\` to insert a blank line.
    </explanation>
    </example>
    <example description="range selection">
    <patch>
    *** Update File: path/to/file.txt
    @@
    -^a
    -...
    -^f
    </patch>
    <explanation>
    Delete first and last matched lines, and delete all lines between them with \`-...\`.
    </explanation>
    </example>
  `);
}

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

interface DryRunFileState {
  exists: boolean;
  text?: string;
}

type PatchReceiptMode = "status" | "hash";

interface PatchExecutionOptions {
  parseOptions: ParsePatchOptions;
  receipt: PatchReceiptMode;
}

interface PatchProfileDefaults {
  receipt: PatchReceiptMode;
}

const PATCH_PROFILE_DEFAULTS: Record<
  LocatorPatchProfile,
  PatchProfileDefaults
> = {
  classic: { receipt: "status" },
  smart: { receipt: "status" },
  hash: { receipt: "hash" },
};

export const patchTool = defineTool({
  name: "patch",
  label: "Locator Patch",
  description:
    "Token-efficient tool for editing files with multi-file-capable add/update/delete patches.",
  promptSnippet:
    "Use this tool for patching. Pick the locator costing the least.",
  promptGuidelines: buildPatchPromptGuidelines("classic"),
  parameters: buildPatchToolParameters("classic"),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (signal?.aborted) {
      throw new Error("Cancelled");
    }

    const patchText = await readPatchInput(
      params.patch,
      params.patch_file,
      ctx.cwd,
    );
    const config = await readLocatorPatchConfig();
    const executionOptions = resolvePatchExecutionOptions(params, config);
    const universalPatch = await parsePatchInputWithRetryPatch(
      patchText,
      executionOptions.parseOptions,
    );
    const dryRun = params.dry_run ?? false;

    if (dryRun) {
      return buildPatchToolResult(
        await planFileChangesForDryRun(ctx.cwd, universalPatch.operations),
        true,
        executionOptions.receipt,
      );
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
        const retryPatchPath = await writeRetryPatch(
          universalPatch.operations.slice(index),
          executionOptions.parseOptions,
        );
        const partialError = new PartialPatchError(
          renderSequentialFailureMessage({
            appliedChanges: plannedChanges,
            failedOperation: operation,
            skippedOperations: universalPatch.operations.slice(index + 1),
            retryPatchPath,
            cause: error,
          }),
        );
        Object.assign(partialError, {
          appliedOperationCount: plannedChanges.length,
          failedOperationIndex: index,
          retryPatchPath,
        });
        throw partialError;
      }
    }

    return buildPatchToolResult(
      plannedChanges,
      false,
      executionOptions.receipt,
    );
  },
  renderCall(_args, theme, context) {
    return new Text(
      buildPatchCallRenderText({
        input: context.args,
        expanded: context.expanded,
        argsComplete: context.argsComplete,
        theme,
      }),
      0,
      0,
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
        theme,
      }),
      0,
      0,
    );
  },
});

export function setPatchToolProfileGuideline(
  profile: LocatorPatchProfile,
): void {
  patchTool.promptGuidelines = buildPatchPromptGuidelines(profile);
  patchTool.parameters = buildPatchToolParameters(profile);
}

function buildPatchToolParameters(profile: LocatorPatchProfile) {
  return Type.Object(
    {
      patch: Type.Optional(
        Type.String({
          description: buildPatchParameterDescription(profile),
        }),
      ),
      patch_file: Type.Optional(
        Type.String({
          description:
            "Path to a UTF-8 patch file. Mutually exclusive with `patch`. Relative paths resolve against cwd.",
        }),
      ),
      dry_run: Type.Optional(
        Type.Boolean({
          description: "Validate/apply in memory and do not write.",
        }),
      ),
      receipt: Type.Optional(
        Type.Union([Type.Literal("status"), Type.Literal("hash")], {
          description:
            "Patch result receipt. Overrides the configured profile default.",
        }),
      ),
    },
    { additionalProperties: false },
  );
}

function buildPatchPromptGuidelines(profile: LocatorPatchProfile): string[] {
  const guidelines = [];
  if (profile === "hash") {
    guidelines.push(
      "Hash profile active: update hunk rows use hashes: use `a`, `-b3`, ranges (`...`, `-...`), and inserts (`+literal`). `patch` success returns a compact hash-only receipt with context hashes and inserted-line hashes. Treat patch receipt as current state for touched hunks.",
    );
  } else if (profile === "smart") {
    guidelines.push(
      "Patch tool smart profile active: context/delete rows use smart locators; `read` remains plain text; patch success returns compact status rows unless overridden.",
    );
  } else {
    guidelines.push(
      "Patch tool classic profile active: context/delete rows without locator markers use exact unified-diff behavior; hash locators and hash receipts require `receipt: \"hash\"`.",
    );
  }
  guidelines.push(
    profile === "classic"
      ? "Classic profile supports explicit locator markers (`:`, `^`, `*`, `$`, `?`, `~`, and hash `#` when hash receipt is enabled)."
      : "Profile controls context/delete row parsing; no per-call row-parsing override exists.",
  );
  return guidelines;
}

function resolvePatchExecutionOptions(
  params: {
    receipt?: PatchReceiptMode;
  },
  config: LocatorPatchConfig,
): PatchExecutionOptions {
  const profileDefaults = PATCH_PROFILE_DEFAULTS[config.profile];
  const receipt = params.receipt ?? profileDefaults?.receipt ?? "status";
  return {
    parseOptions: {
      profile: config.profile,
      strictHashRows: config.profile === "hash",
      hashLocatorsEnabled: receipt === "hash",
    },
    receipt,
  };
}

async function readPatchInput(
  patch: string | undefined,
  patchFile: string | undefined,
  cwd: string,
): Promise<string> {
  const hasInlinePatch = typeof patch === "string";
  const hasPatchFile = typeof patchFile === "string";
  if (hasInlinePatch === hasPatchFile) {
    throw new InvalidPatchError(
      "Provide exactly one of 'patch' or 'patch_file'.",
    );
  }
  if (hasInlinePatch) {
    return patch;
  }

  const patchFilePath = resolveToolPath(cwd, patchFile ?? "");
  const { text } = await readExistingTextFile(patchFilePath);
  return text;
}

async function parsePatchInputWithRetryPatch(
  patchText: string,
  parseOptions: ParsePatchOptions,
) {
  try {
    return parsePatchInput(patchText, undefined, parseOptions);
  } catch (error) {
    if (!(error instanceof InvalidPatchError)) {
      throw error;
    }
    const retryPatchPath = await writeRawRetryPatch(patchText);
    const retryableError = new InvalidPatchError(
      `${error.detail}\nRetry patch: ${retryPatchPath}`,
      error.location,
    );
    Object.assign(retryableError, { retryPatchPath });
    throw retryableError;
  }
}

async function applyOperationSequentially(
  cwd: string,
  operation: UniversalPatchOperation,
): Promise<PlannedFileChange> {
  const operationTarget = await prepareOperationTarget(cwd, operation);
  return withFileMutationQueue(operationTarget.targetPath, async () => {
    const change = await planFileChange(operationTarget);
    await writePlannedChange(change);
    return change;
  });
}

async function prepareOperationTargets(
  cwd: string,
  operations: readonly UniversalPatchOperation[],
): Promise<OperationTarget[]> {
  const operationTargets: OperationTarget[] = [];
  for (const operation of operations) {
    operationTargets.push(await prepareOperationTarget(cwd, operation));
  }
  rejectDuplicateResolvedTargets(operationTargets);
  return operationTargets;
}

async function prepareOperationTarget(
  cwd: string,
  operation: UniversalPatchOperation,
): Promise<OperationTarget> {
  const targetPath =
    operation.kind === "add"
      ? await resolveNewTextFileTarget(cwd, operation.path)
      : await resolveExistingRealPath(cwd, operation.path);
  return { operation, targetPath };
}

async function planFileChanges(
  operationTargets: readonly OperationTarget[],
): Promise<PlannedFileChange[]> {
  const plannedChanges: PlannedFileChange[] = [];
  for (const operationTarget of operationTargets) {
    plannedChanges.push(await planFileChange(operationTarget));
  }
  return plannedChanges;
}

async function planFileChangesForDryRun(
  cwd: string,
  operations: readonly UniversalPatchOperation[],
): Promise<PlannedFileChange[]> {
  const plannedChanges: PlannedFileChange[] = [];
  const virtualFiles = new Map<string, DryRunFileState>();

  for (const operation of operations) {
    const targetPath = await resolveDryRunTargetPath(cwd, operation);
    const change = await planFileChangeForDryRun(
      { operation, targetPath },
      virtualFiles,
    );
    plannedChanges.push(change);
    updateDryRunFileState(virtualFiles, change);
  }

  return plannedChanges;
}

async function resolveDryRunTargetPath(
  cwd: string,
  operation: UniversalPatchOperation,
): Promise<string> {
  if (operation.kind !== "add") {
    const existingPath = await resolveExistingRealPath(
      cwd,
      operation.path,
    ).catch(() => undefined);
    if (existingPath) {
      return existingPath;
    }
  }
  return resolvePathThroughExistingParent(cwd, operation.path);
}

async function resolvePathThroughExistingParent(
  cwd: string,
  inputPath: string,
): Promise<string> {
  const absolutePath = resolveToolPath(cwd, inputPath);
  const realParentDirectory = await realpath(dirname(absolutePath)).catch(
    () => {
      throw new FileTextError(
        `Parent directory not found: ${dirname(absolutePath)}`,
      );
    },
  );
  return resolve(realParentDirectory, basename(absolutePath));
}

async function planFileChangeForDryRun(
  operationTarget: OperationTarget,
  virtualFiles: Map<string, DryRunFileState>,
): Promise<PlannedFileChange> {
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
    };
  }

  const oldText = await readDryRunExistingText(targetPath, state);
  if (operation.kind === "delete") {
    return {
      operation: "delete",
      patchPath: operation.path,
      targetPath,
      oldText,
      newText: undefined,
    };
  }

  const applyResult = applyPatchToText(oldText, operation.patch);
  return {
    operation: "update",
    patchPath: operation.path,
    targetPath,
    oldText,
    newText: applyResult.text,
    applyResult,
  };
}

async function assertDryRunNewTarget(
  targetPath: string,
  state: DryRunFileState | undefined,
): Promise<void> {
  if (state?.exists) {
    throw new FileTextError(`Add File target already exists: ${targetPath}`);
  }
  if (!state) {
    await assertNewTextFileTarget(targetPath);
    return;
  }
  await access(
    dirname(targetPath),
    constants.R_OK | constants.W_OK | constants.X_OK,
  ).catch(() => {
    throw new FileTextError(
      `Directory is not readable and writable: ${dirname(targetPath)}`,
    );
  });
}

async function readDryRunExistingText(
  targetPath: string,
  state: DryRunFileState | undefined,
): Promise<string> {
  if (state) {
    if (!state.exists) {
      throw new FileTextError(`File not found: ${targetPath}`);
    }
    return state.text ?? "";
  }
  const { text } = await readExistingTextFile(targetPath, { writable: true });
  return text;
}

function updateDryRunFileState(
  virtualFiles: Map<string, DryRunFileState>,
  change: PlannedFileChange,
): void {
  if (change.operation === "delete") {
    virtualFiles.set(change.targetPath, { exists: false });
    return;
  }
  virtualFiles.set(change.targetPath, {
    exists: true,
    text: change.newText ?? "",
  });
}

async function writeRetryPatch(
  operations: readonly UniversalPatchOperation[],
  parseOptions: ParsePatchOptions,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-locator-patch-"));
  const retryPatchPath = join(directory, "retry.patch");
  await writeRawFile(retryPatchPath, serializeUniversalPatch(operations, parseOptions), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return retryPatchPath;
}

async function writeRawRetryPatch(patchText: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-locator-patch-"));
  const retryPatchPath = join(directory, "retry.patch");
  await writeRawFile(retryPatchPath, patchText, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
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
    `Retry patch: ${args.retryPatchPath}`,
  ];
  return sections.join("\n");
}

function renderAppliedOperationList(
  changes: readonly PlannedFileChange[],
): string {
  if (changes.length === 0) {
    return "(none)";
  }
  return changes
    .map(
      (change) =>
        `*** ${capitalizeOperation(change.operation)} File: ${change.patchPath}`,
    )
    .join("\n");
}

function renderOperationList(
  operations: readonly UniversalPatchOperation[],
): string {
  if (operations.length === 0) {
    return "(none)";
  }
  return operations.map(renderOperationHeader).join("\n");
}

function renderOperationHeader(operation: UniversalPatchOperation): string {
  return `*** ${capitalizeOperation(operation.kind)} File: ${operation.path}`;
}

function capitalizeOperation(
  operation: UniversalPatchOperation["kind"],
): "Add" | "Update" | "Delete" {
  if (operation === "add") return "Add";
  if (operation === "update") return "Update";
  return "Delete";
}

function formatCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function buildPatchToolResult(
  plannedChanges: readonly PlannedFileChange[],
  dryRun: boolean,
  receipt: PatchReceiptMode,
) {
  const locatorEfficiency = getPatchLocatorEfficiency(plannedChanges);
  const locatorWarning = formatLocatorCostWarning(locatorEfficiency);
  const status = buildPatchStatusDecision(plannedChanges, dryRun, receipt, locatorWarning);
  return {
    content: [{ type: "text" as const, text: status.text }],
    details: {
      dryRun,
      diff: renderPatchTranscriptDiffs(plannedChanges.map(toDiffInput)),
      files: plannedChanges.map((change) => ({
        path: change.targetPath,
        patchPath: change.patchPath,
        operation: change.operation,
        lineCount:
          change.operation === "delete"
            ? 0
            : parseText(change.newText ?? "").lines.length,
        audit: change.applyResult
          ? { hunkAudits: change.applyResult.hunkAudits }
          : undefined,
      })),
      status: {
        omitted: status.omitted,
        omitReason: status.omitReason,
        overflow: status.overflow,
        visibleLineCount: status.visibleLineCount,
      },
      charEfficiency: getPatchCharEfficiency(plannedChanges),
      locatorEfficiency,
    },
  };
}

async function planFileChange(
  operationTarget: OperationTarget,
): Promise<PlannedFileChange> {
  const { operation, targetPath } = operationTarget;
  if (operation.kind === "add") {
    const newText = serializeAddFileText(operation);
    await assertNewTextFileTarget(targetPath);
    return {
      operation: "add",
      patchPath: operation.path,
      targetPath,
      newText,
    };
  }

  await assertExistingTextFileMutationTarget(targetPath);
  const { text: oldText } = await readExistingTextFile(targetPath, {
    writable: true,
  });

  if (operation.kind === "delete") {
    return {
      operation: "delete",
      patchPath: operation.path,
      targetPath,
      oldText,
      newText: undefined,
    };
  }

  const applyResult = applyPatchToText(oldText, operation.patch);
  return {
    operation: "update",
    patchPath: operation.path,
    targetPath,
    oldText,
    newText: applyResult.text,
    applyResult,
  };
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

function rejectDuplicateResolvedTargets(
  operationTargets: readonly OperationTarget[],
): void {
  const seen = new Map<string, UniversalPatchOperation>();
  for (const { operation, targetPath } of operationTargets) {
    const existing = seen.get(targetPath);
    if (existing) {
      throw new InvalidPatchError(
        `Multiple operations resolve to the same target: ${existing.path} and ${operation.path}`,
      );
    }
    seen.set(targetPath, operation);
  }
}

function serializeAddFileText(operation: AddFileOperation): string {
  return serializeText({
    bom: false,
    finalNewline: operation.finalNewline,
    lines: operation.lines,
    newline: "\n",
  });
}

function getPatchCharEfficiency(
  plannedChanges: readonly PlannedFileChange[],
): PatchCharEfficiency {
  return sumPatchEfficiencies(plannedChanges, getFileChangeCharEfficiency);
}

function getPatchLocatorEfficiency(
  plannedChanges: readonly PlannedFileChange[],
): PatchCharEfficiency {
  return sumPatchEfficiencies(plannedChanges, getFileChangeLocatorEfficiency);
}

function sumPatchEfficiencies(
  plannedChanges: readonly PlannedFileChange[],
  getChangeEfficiency: (change: PlannedFileChange) => PatchCharEfficiency,
): PatchCharEfficiency {
  return plannedChanges.reduce(
    (total, change) => {
      const changeEfficiency = getChangeEfficiency(change);
      return {
        patchChars: total.patchChars + changeEfficiency.patchChars,
        baselineChars: total.baselineChars + changeEfficiency.baselineChars,
      };
    },
    { patchChars: 0, baselineChars: 0 },
  );
}

function getFileChangeCharEfficiency(
  change: PlannedFileChange,
): PatchCharEfficiency {
  if (change.operation === "add") {
    const chars = prefixedTextLinesCharCount(change.newText ?? "");
    return { patchChars: chars, baselineChars: chars };
  }
  if (change.operation === "delete") {
    return {
      patchChars: 0,
      baselineChars: prefixedTextLinesCharCount(change.oldText ?? ""),
    };
  }

  const hunkAudits = change.applyResult?.hunkAudits ?? [];
  return hunkAudits.reduce(
    (total, hunkAudit) => ({
      patchChars: total.patchChars + hunkAudit.patchCharCount,
      baselineChars: total.baselineChars + hunkAudit.baselineCharCount,
    }),
    { patchChars: 0, baselineChars: 0 },
  );
}

function getFileChangeLocatorEfficiency(
  change: PlannedFileChange,
): PatchCharEfficiency {
  if (change.operation !== "update") {
    return { patchChars: 0, baselineChars: 0 };
  }

  const hunkAudits = change.applyResult?.hunkAudits ?? [];
  return hunkAudits.reduce(
    (total, hunkAudit) => ({
      patchChars: total.patchChars + hunkAudit.locatorPatchCharCount,
      baselineChars: total.baselineChars + hunkAudit.locatorBaselineCharCount,
    }),
    { patchChars: 0, baselineChars: 0 },
  );
}

function prefixedTextLinesCharCount(text: string): number {
  return parseText(text).lines.reduce(
    (total, line) => total + line.length + 1,
    0,
  );
}

function buildPatchStatusDecision(
  plannedChanges: readonly PlannedFileChange[],
  dryRun: boolean,
  receipt: PatchReceiptMode,
  locatorWarning: string | undefined,
): PatchStatusDecision {
  const visibleText = appendOptionalLine(
    receipt === "hash"
      ? renderPatchHashReceiptDiffs(plannedChanges.map(toDiffInput))
      : renderUniversalPatchStatus(plannedChanges, dryRun),
    locatorWarning,
  );
  const visibleLineCount = countRenderedLines(visibleText);
  const overflow = getVisibleOutputOverflow(visibleText, visibleLineCount);
  if (overflow) {
    const text = appendOptionalLine(renderUniversalPatchStatus(plannedChanges, dryRun), locatorWarning);
    return {
      text,
      omitted: true,
      omitReason: "too_large",
      overflow,
      visibleLineCount: countRenderedLines(text),
    };
  }

  return {
    text: visibleText,
    omitted: false,
    visibleLineCount,
  };
}

function appendOptionalLine(text: string, line: string | undefined): string {
  return line ? `${text}\n${line}` : text;
}

function renderUniversalPatchStatus(
  plannedChanges: readonly PlannedFileChange[],
  dryRun: boolean,
): string {
  return plannedChanges
    .map((change) => renderFileStatus(change, dryRun))
    .join("\n");
}

function renderFileStatus(change: PlannedFileChange, dryRun: boolean): string {
  const status = dryRun
    ? "Validated"
    : change.operation === "delete"
      ? "Deleted file"
      : "Applied";
  return [
    `*** ${capitalizeOperation(change.operation)} File: ${change.patchPath}`,
    status,
  ].join("\n");
}

function toDiffInput(change: PlannedFileChange): PatchTranscriptDiffInput {
  return {
    kind: change.operation,
    path: change.patchPath,
    oldText: change.oldText,
    newText: change.newText,
    applyResult: change.applyResult,
  };
}

function withMutationQueues<T>(
  paths: readonly string[],
  callback: () => Promise<T>,
): Promise<T> {
  const [firstPath, ...remainingPaths] = paths;
  if (!firstPath) {
    return callback();
  }
  return withFileMutationQueue(firstPath, () =>
    withMutationQueues(remainingPaths, callback),
  );
}
