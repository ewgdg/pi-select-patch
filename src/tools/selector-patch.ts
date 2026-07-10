import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
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
import { type SelectorPatchProfile } from "../config.js";
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
  readExistingTextFile,
  resolveExistingRealPath,
  resolveToolPath,
  resolveNewTextFileTarget,
  writeNewTextFileAtomically,
  writeTextFileAtomically,
} from "../fs-text.js";
import { type SelectorEfficiency } from "../selector-efficiency.js";
import { type PatchSizeComparison } from "../patch-size.js";
import {
  countRenderedLines,
  getVisibleOutputOverflow,
  type VisibleOutputOverflow,
} from "../output-size.js";
import { type ParsePatchOptions } from "../patch-format.js";
import { parseText, serializeText } from "../text-lines.js";
import {
  copyUniversalPatchInputTail,
  parsePatchInput,
  type AddFileOperation,
  type UniversalPatch,
  type UniversalPatchOperation,
} from "../universal-patch-format.js";
import {
  buildPatchCallRenderText,
  buildPatchResultRenderText,
  getPatchResultText,
} from "./patch-render.js";
import { dedentBlock } from "../dedent.js";

function buildPatchParameterDescription(profile: SelectorPatchProfile): string {
  const hunkMatchDescription = indentNonBlankLines(buildPatchHunkMatchDescription(profile), "    ");
  const examples = indentNonBlankLines(buildPatchParameterExamples(profile), "    ");
  return dedentBlock(`
    <description>
    Inline patch text. Mutually exclusive with \`patch_file\`.
    No outer wrapper; start directly with a file section header. Do not include \`*** Begin Patch\` or \`*** End Patch\` boundaries.
    ## File Sections
    A patch may contain multiple \`*** Update File\` sections;
    a file section header includes a file path.
    ## Hunk Sections
    Each \`Update File\` section may contain multiple \`@@\` hunks.
    Within one \`Update File\` section, later hunks may match or span only untouched original target lines; they cannot anchor on or range across lines inserted or already used by earlier hunks. To make an edit depend on prior output, use a later \`*** Update File\` section for the same path.
    Hunk headers are \`@@\`.
    ### Line Anchor
    A line anchor can be appended to a hunk header.
    Line number is 1-based.
    Line anchors define the allowed 1-based match span: [start, +inf) for \`@@ @<start>\`, or [start, end] for \`@@ @<start>...<end>\`.
${hunkMatchDescription}
    Each context/delete selector row consumes exactly one target line. Adjacent selector rows must match adjacent target lines unless separated by a range row. Do not add separate keyword locator rows for the same physical line; shorten the selector row itself instead.
    ### Insertion
    Patch uses a leading "+" operator to insert lines.
    The "+" char must be first char of the line.
    The syntax is \`+<text>\`, where \`<text>\` is raw line content.
    Only hunk sections may insert lines.

    ### Intra-line replacement
    Use a \`/old\` row immediately followed by a \`=new\` row after a context selector to literally replace text inside the previously selected line.
    \`old\` is raw text after \`/\`, must be non-empty, and must appear exactly once in the selected line. \`new\` is raw text after \`=\` and may be empty. Text starts immediately after the operator: \`//old\` means old text is \`/old\`, and \`==new\` means new text is \`=new\`. Consecutive replacement pairs apply sequentially to that same selected line. Replacement rows do not use regex.
    </description>

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

function buildPatchHunkMatchDescription(profile: SelectorPatchProfile): string {
  if (profile === "smart") {
    return dedentBlock(`
      ### Hunk Match: Smart Profile
      Context/delete rows use smart selectors after a required unified-diff operator.
      Every hunk body row must start with an operator: literal space for context, \`-\` for delete, \`+\` for insert, or a \`/old\`/\`=new\` pair for intra-line replacement on the previous context row.
      Use \` <selector>\` rows for context and \`-<selector>\` rows for deletes. A bare selector line like \`selector text\` is invalid because it is missing the leading space operator.
      Use a blank hunk row or single-space row for blank context; use \`-\` to delete a blank line.
      Smart selectors resolve independently through resolver tiers: exact, prefix/suffix, contains, whitespace token-subsequence, bounded fuzzy token-subsequence, then character subsequence; The whole hunk applies only with one dominance winner.
      Range rows are \` ...\` for preserved/skipped context and \`-...\` for deleted ranges.
    `);
  }
  if (profile === "hash") {
    return dedentBlock(`
      ### Hunk Match: Hash Profile
      Context/delete rows identify lines by hash after a required unified-diff operator.
      Every hunk body row must start with an operator: literal space for context, \`-\` for delete, \`+\` for insert, or a \`/old\`/\`=new\` pair for intra-line replacement on the previous context row.
      Copy only the 1- to 4-character hash from \`HASH│content\` read output, not the separator or content.
      Use \` <hash>\` for context and \`-<hash>\` for deletes. A bare hash line like \`abc\` is invalid because it is missing the leading space operator.
      Use only the hash characters from read output; omit \`#\`.
      Range rows are \` ...\` for preserved/skipped context and \`-...\` for deleted ranges.
    `);
  }
  return dedentBlock(`
    ### Hunk Match: Classic Profile
    A hunk contains line matchers. A matcher / match row is operator plus selector.
    Every hunk body row must start with an operator: literal space for context, "-" for delete, "+" for insert, or a "/old"/"=new" pair for intra-line replacement on the previous context row.
    Match operators are "-" for delete and literal space " " for context. Insert rows use "+" plus literal content and have no selector.
    Context selector rows may omit the leading space when the row starts with a selector marker.
    Selector markers:
    - \`^<prefix>\`: prefix match
    - \`:<text>\`: exact raw line match
    - \`$<suffix>\`: suffix match
    - \`*<text>\`: contains match
    - \`~<text>\`: smart match for context rows
    - \`#<hash>\`: hash match when hash selectors are enabled by \`receipt: "hash"\`
    - \`?<json-obj>\`: combined selector with \`prefix\`, \`contains\`, and/or \`suffix\`
    - \`...\`: range row; use \`...\` for context range and \`-...\` for delete range
    If no selector marker follows the operator, classic profile uses exact unified-diff matching: \` text\` is exact context and \`-text\` is exact delete. Bare exact context text like \`text\` is invalid because it is missing the leading space operator.
  `);
}

function buildPatchProfilePolicy(profile: SelectorPatchProfile): string {
  if (profile === "smart") {
    return "Always prefer short prefix or sampled-word subsequence selectors over full-line exact selectors. Include enough neighboring smart context or an anchor hint when text may repeat. Sample n words from a line to form a subsequence match, where n <= 0.5 * total word count. Use full-line exact selectors only when the target line is already short or needed to disambiguate.";
  }
  if (profile === "hash") {
    return "Prefer the shortest unique hash width available from `read`. Use ` ...`/`-...` ranges to avoid listing many unchanged/deleted hashes.";
  }
  return "Use partial-match-based selectors when target/context lines are long enough that shortened prefix/suffix/contains saves more than selector marker cost. Use hash selectors only when hash selectors are enabled and a hash is already known. Use the shortest prefix/suffix/contains selector that uniquely identifies the target line in hunk context. Avoid exact text selectors and unified-diff format unless needed to disambiguate hunk matches.";
}

function buildPatchParameterExamples(profile: SelectorPatchProfile): string {
  if (profile === "smart") {
    return dedentBlock(`
      <example description="smart insertion">
      <file_content>
      This is a very long long long stable anchor
      </file_content>
      <patch>
      *** Update File: path/to/file.txt
      @@
       a long anchor
      +new line
      </patch>
      <explanation>
      "a long anchor" is a sampled selector: it uses selected words from the longer anchor line, then matches by token subsequence.
      </explanation>
      </example>
      <example description="smart range deletion">
      <patch>
      *** Update File: path/to/file.txt
      @@
       function test
      -{
      -...
      -return result
      -}
      </patch>
      <explanation>
      Smart context selectors anchor the range. \`-...\` deletes all matched lines between them.
      </explanation>
      </example>
      <example description="code block handling">
      <code_block>
      long_object_name.long_function_call(long_arg_name)
      </code_block>
      <patch>
      *** Update File: path/to/file.txt
      @@
      -long_obj.long_call(arg)
      +another_call(arg)
      </patch>
      <explanation>
      Uses char subsequence to match long code line.
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
      Hash profile rows use unified-diff operators plus only the hash before \`│\`. Omit \`#\`.
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
    <example description="patch selector cost efficiency">
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
    Exact text match works, but costs more than shorter selectors.
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
  SelectorPatchProfile,
  PatchProfileDefaults
> = {
  classic: { receipt: "status" },
  smart: { receipt: "status" },
  hash: { receipt: "hash" },
};

export function createPatchTool(profile: SelectorPatchProfile) {
  return defineTool({
    name: "patch",
    label: "Select Patch",
    description:
      "Token-efficient tool for editing files with multi-file-capable update patches.",
    promptSnippet:
      "Use this tool for line-based patching. Use shorter selectors.",
    promptGuidelines: buildPatchPromptGuidelines(profile),
    parameters: buildPatchToolParameters(profile),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (signal?.aborted) {
      throw new Error("Cancelled");
    }

    const patchText = await readPatchInput(
      params.patch,
      params.patch_file,
      ctx.cwd,
    );
    const executionOptions = resolvePatchExecutionOptions(params, profile);
    const universalPatch = await parsePatchInputWithRetryPatch(
      patchText,
      executionOptions.parseOptions,
    );
    const dryRun = params.dry_run ?? false;

    if (dryRun) {
      return buildPatchToolResult(
        await planFileChangesForDryRun(ctx.cwd, universalPatch.operations),
        universalPatch,
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
        const retryPatch = await tryWriteRetryPatch(
          universalPatch,
          index,
        );
        const partialError = new PartialPatchError(
          renderSequentialFailureMessage({
            appliedChanges: plannedChanges,
            failedOperation: operation,
            skippedOperations: universalPatch.operations.slice(index + 1),
            retryPatch,
            cause: error,
          }),
        );
        Object.assign(partialError, {
          appliedOperationCount: plannedChanges.length,
          failedOperationIndex: index,
          ...(retryPatch.path ? { retryPatchPath: retryPatch.path } : {}),
          ...(retryPatch.error ? { retryPatchError: retryPatch.error } : {}),
        });
        throw partialError;
      }
    }

    return buildPatchToolResult(
      plannedChanges,
      universalPatch,
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
}


function buildPatchToolParameters(profile: SelectorPatchProfile) {
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

function buildPatchPromptGuidelines(profile: SelectorPatchProfile): string[] {
  return [
    dedentBlock(`
      <patch_tool_policy>
      Prefer short selectors plus accurate line anchors when available over long exact selectors.
      Short selectors do not imply high error rate when surrounding context disambiguates the hunk.
      Long selectors usually cost more than their small error-rate drop is worth.
      ${buildPatchProfilePromptGuideline(profile)}
      ${profile === "classic" ? "Classic profile supports explicit selector markers (`:`, `^`, `*`, `$`, `?`, `~`, and hash `#` when hash receipt is enabled)." : "Profile controls context/delete row parsing; no per-call row-parsing override exists."}
      ${buildPatchProfilePolicy(profile)}
      Use range selector whenever possible for spans over 3 lines.
      Use line anchors to disambiguate only if the latest accurate line offset is available or add extra redundancy to the anchors.
      If the tool returns a retry patch file containing large chunks of unapplied operations due to failures, fix the retry patch file and pass it via \`patch_file\` instead of re-emitting large patch text.
      </patch_tool_policy>
    `),
  ];
}

function buildPatchProfilePromptGuideline(profile: SelectorPatchProfile): string {
  if (profile === "hash") {
    return "Hash profile active: hunk context rows use hashes after operators. `patch` success returns a compact hash-only receipt with context hashes and inserted-line hashes. Treat patch receipt as current state for touched hunks.";
  }
  if (profile === "smart") {
    return "";
  }
  return "";
}

function resolvePatchExecutionOptions(
  params: {
    receipt?: PatchReceiptMode;
  },
  profile: SelectorPatchProfile,
): PatchExecutionOptions {
  const profileDefaults = PATCH_PROFILE_DEFAULTS[profile];
  const receipt = params.receipt ?? profileDefaults?.receipt ?? "status";
  return {
    parseOptions: {
      profile,
      strictHashRows: profile === "hash",
      hashSelectorsEnabled: receipt === "hash",
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
  virtualFiles.set(change.targetPath, {
    exists: true,
    text: change.newText ?? "",
  });
}

async function writeRetryPatch(
  universalPatch: UniversalPatch,
  startOperationIndex: number,
): Promise<string> {
  const retryPatchPath = await createRetryPatchPath();
  await writeRawFile(retryPatchPath, copyUniversalPatchInputTail(universalPatch, startOperationIndex), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return retryPatchPath;
}

async function tryWriteRetryPatch(
  universalPatch: UniversalPatch,
  startOperationIndex: number,
): Promise<{ path?: string; error?: unknown }> {
  try {
    return { path: await writeRetryPatch(universalPatch, startOperationIndex) };
  } catch (error) {
    return { error };
  }
}

async function writeRawRetryPatch(patchText: string): Promise<string> {
  const retryPatchPath = await createRetryPatchPath();
  await writeRawFile(retryPatchPath, patchText, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return retryPatchPath;
}

async function createRetryPatchPath(): Promise<string> {
  const directory = join(tmpdir(), "pi-select-patch");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${randomUUID()}.patch`);
}

function renderSequentialFailureMessage(args: {
  appliedChanges: readonly PlannedFileChange[];
  failedOperation: UniversalPatchOperation;
  skippedOperations: readonly UniversalPatchOperation[];
  retryPatch: { path?: string; error?: unknown };
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
    renderRetryPatchStatus(args.retryPatch),
  ];
  return sections.join("\n");
}

function renderRetryPatchStatus(retryPatch: { path?: string; error?: unknown }): string {
  if (retryPatch.path) return `Retry patch: ${retryPatch.path}`;
  return `Retry patch unavailable: ${formatCause(retryPatch.error)}`;
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
): "Add" | "Update" {
  if (operation === "add") return "Add";
  return "Update";
}

function formatCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function buildPatchToolResult(
  plannedChanges: readonly PlannedFileChange[],
  universalPatch: UniversalPatch,
  dryRun: boolean,
  receipt: PatchReceiptMode,
) {
  const selectorEfficiency = getPatchSelectorEfficiency(plannedChanges);
  const status = buildPatchStatusDecision(plannedChanges, dryRun, receipt);
  return {
    content: [{ type: "text" as const, text: status.text }],
    details: {
      dryRun,
      diff: renderPatchTranscriptDiffs(plannedChanges.map(toDiffInput)),
      files: plannedChanges.map((change) => ({
        path: change.targetPath,
        patchPath: change.patchPath,
        operation: change.operation,
        lineCount: parseText(change.newText ?? "").lines.length,
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
      patchSize: getPatchSize(universalPatch, plannedChanges),
      selectorEfficiency,
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

interface PatchBodyComparison {
  patchChars: number;
  patchLines: number;
  unifiedDiffChars: number;
  unifiedDiffLines: number;
}

function getPatchSize(
  universalPatch: UniversalPatch,
  plannedChanges: readonly PlannedFileChange[],
): PatchSizeComparison {
  if (!universalPatch.source) {
    throw new Error("Internal patch error: normalized source input is missing.");
  }

  const patchChars = universalPatch.source.lines.join("\n").length;
  const body = plannedChanges.reduce(
    (total, change) => addPatchBodyComparisons(total, getFileChangeBodyComparison(change)),
    { patchChars: 0, patchLines: 0, unifiedDiffChars: 0, unifiedDiffLines: 0 },
  );
  // Expanded ranges/replacements change row count, so their line separators must change too.
  const unifiedDiffChars = patchChars
    - body.patchChars
    + body.unifiedDiffChars
    + body.unifiedDiffLines
    - body.patchLines;

  return { patchChars, unifiedDiffChars };
}

function addPatchBodyComparisons(left: PatchBodyComparison, right: PatchBodyComparison): PatchBodyComparison {
  return {
    patchChars: left.patchChars + right.patchChars,
    patchLines: left.patchLines + right.patchLines,
    unifiedDiffChars: left.unifiedDiffChars + right.unifiedDiffChars,
    unifiedDiffLines: left.unifiedDiffLines + right.unifiedDiffLines,
  };
}

function getFileChangeBodyComparison(change: PlannedFileChange): PatchBodyComparison {
  if (change.operation === "add") {
    const lines = parseText(change.newText ?? "").lines;
    const chars = prefixedTextLinesCharCount(lines);
    return { patchChars: chars, patchLines: lines.length, unifiedDiffChars: chars, unifiedDiffLines: lines.length };
  }
  if (!change.applyResult) {
    throw new Error("Internal patch error: update size requires apply result.");
  }
  return change.applyResult.hunkAudits.reduce(
    (total, audit) => addPatchBodyComparisons(total, {
      patchChars: audit.patchCharCount,
      patchLines: audit.patchLineCount,
      unifiedDiffChars: audit.baselineCharCount,
      unifiedDiffLines: audit.baselineLineCount,
    }),
    { patchChars: 0, patchLines: 0, unifiedDiffChars: 0, unifiedDiffLines: 0 },
  );
}

function getPatchSelectorEfficiency(
  plannedChanges: readonly PlannedFileChange[],
): SelectorEfficiency {
  return sumSelectorEfficiencies(plannedChanges, getFileChangeSelectorEfficiency);
}

function sumSelectorEfficiencies(
  plannedChanges: readonly PlannedFileChange[],
  getChangeEfficiency: (change: PlannedFileChange) => SelectorEfficiency,
): SelectorEfficiency {
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

function getFileChangeSelectorEfficiency(
  change: PlannedFileChange,
): SelectorEfficiency {
  if (change.operation !== "update") {
    return { patchChars: 0, baselineChars: 0 };
  }

  const hunkAudits = change.applyResult?.hunkAudits ?? [];
  return hunkAudits.reduce(
    (total, hunkAudit) => ({
      patchChars: total.patchChars + hunkAudit.selectorPatchCharCount,
      baselineChars: total.baselineChars + hunkAudit.selectorBaselineCharCount,
    }),
    { patchChars: 0, baselineChars: 0 },
  );
}

function prefixedTextLinesCharCount(lines: readonly string[]): number {
  return lines.reduce(
    (total, line) => total + line.length + 1,
    0,
  );
}

function buildPatchStatusDecision(
  plannedChanges: readonly PlannedFileChange[],
  dryRun: boolean,
  receipt: PatchReceiptMode,
): PatchStatusDecision {
  const visibleText = receipt === "hash"
    ? renderPatchHashReceiptDiffs(plannedChanges.map(toDiffInput))
    : renderUniversalPatchStatus(plannedChanges, dryRun);
  const visibleLineCount = countRenderedLines(visibleText);
  const overflow = getVisibleOutputOverflow(visibleText, visibleLineCount);
  if (overflow) {
    const text = renderUniversalPatchStatus(plannedChanges, dryRun);
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

function renderUniversalPatchStatus(
  plannedChanges: readonly PlannedFileChange[],
  dryRun: boolean,
): string {
  return plannedChanges
    .map((change) => renderFileStatus(change, dryRun))
    .join("\n");
}

function renderFileStatus(change: PlannedFileChange, dryRun: boolean): string {
  const status = dryRun ? "Validated" : "Applied";
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
