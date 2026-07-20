import {
  defineTool,
  generateUnifiedPatch,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  InvalidReplaceError,
  ReplaceAmbiguousError,
  ReplaceNotFoundError,
  ReplaceWriteError,
} from "../errors.js";
import {
  createTextFilePathResolutionError,
  readExistingTextFile,
  resolveExistingRealPath,
} from "../fs-text.js";
import {
  directTextFilePublicationBackend,
  type TextFilePublicationBackend,
} from "../text-file-publication.js";
import {
  buildReplaceCallRenderText,
  buildReplaceResultRenderText,
} from "./replace-render.js";
import { getPatchResultText } from "./patch-render.js";

const replaceParameters = Type.Object(
  {
    file_path: Type.String({ description: "Path to the file to modify." }),
    old_string: Type.String({ description: "Exact text to replace." }),
    new_string: Type.String({ description: "Replacement text." }),
    replace_all: Type.Optional(
      Type.Boolean({
        description: "Replace all occurrences instead of requiring a unique match.",
        default: false,
      }),
    ),
  },
  { additionalProperties: false },
);

export type ReplaceToolInput = Static<typeof replaceParameters>;

export interface ReplaceToolDetails {
  diff: string;
  occurrenceCount: number;
}

export interface ReplaceToolOptions {
  publicationBackend?: TextFilePublicationBackend;
}

interface ReplacementPlan {
  occurrenceCount: number;
  serializedResult: string;
}

const UTF8_BOM = "\uFEFF";
const MAX_WRITE_ERROR_CAUSE_CHARACTERS = 300;
const WRITE_ERROR_OMISSION_MARKER = "...";

export function createReplaceTool(options: ReplaceToolOptions = {}) {
  const publicationBackend = options.publicationBackend ?? directTextFilePublicationBackend;

  return defineTool({
    name: "replace",
    label: "Replace",
    renderShell: "default",
    description: "Replace exact literal text in one file.",
    promptSnippet: "Replace exact literal text in one file.",
    parameters: replaceParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const validatedInput = validateReplacementInput(params);
      throwIfCancelled(signal);

      const realTargetPath = await resolveExistingRealPath(ctx.cwd, validatedInput.file_path);
      try {
        return await withFileMutationQueue(realTargetPath, async () => {
          throwIfCancelled(signal);
          const target = await readExistingTextFile(realTargetPath, {
            writable: true,
            displayPath: validatedInput.file_path,
          });
          const plan = planReplacement(target.text, validatedInput);
          const diff = generateUnifiedPatch(
            validatedInput.file_path,
            target.text,
            plan.serializedResult,
          );

          onUpdate?.({
            content: [{ type: "text", text: "Replacing..." }],
            details: undefined,
          });
          throwIfCancelled(signal);
          try {
            await publicationBackend.replaceExisting(target.path, plan.serializedResult);
          } catch (error) {
            throw new ReplaceWriteError(
              `${boundedErrorCause(error)}. The file may be partially written or truncated. Reread it before retrying.`,
            );
          }

          return {
            content: [{
              type: "text" as const,
              text: plan.occurrenceCount === 1
                ? "Replaced 1 occurrence."
                : `Replaced ${plan.occurrenceCount} occurrences.`,
            }],
            details: {
              diff,
              occurrenceCount: plan.occurrenceCount,
            } satisfies ReplaceToolDetails,
          };
        });
      } catch (error) {
        if (hasNodeFilesystemErrorCode(error)) {
          throw createTextFilePathResolutionError(validatedInput.file_path, error);
        }
        throw error;
      }
    },
    renderCall(_args, theme, context) {
      return new Text(buildReplaceCallRenderText({
        input: context.args,
        argsComplete: context.argsComplete,
        expanded: context.expanded,
        theme,
      }), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      return new Text(buildReplaceResultRenderText({
        resultText: getPatchResultText(result),
        details: result.details,
        expanded,
        isPartial,
        isError: context.isError,
        errorInput: context.args,
        theme,
      }), 0, 0);
    },
  });
}

function validateReplacementInput(input: ReplaceToolInput): Required<ReplaceToolInput> {
  const oldString = canonicalizeNewlines(input.old_string);
  const newString = canonicalizeNewlines(input.new_string);

  validateTextInput("old_string", input.old_string);
  validateTextInput("new_string", input.new_string);
  if (oldString.length === 0) {
    throw new InvalidReplaceError("old_string must not be empty.");
  }
  if (oldString === newString) {
    throw new InvalidReplaceError("old_string and new_string must differ after newline canonicalization.");
  }

  return {
    file_path: input.file_path,
    old_string: oldString,
    new_string: newString,
    replace_all: input.replace_all ?? false,
  };
}

function validateTextInput(name: "old_string" | "new_string", value: string): void {
  if (value.includes("\0")) {
    throw new InvalidReplaceError(`${name} must not contain NUL characters.`);
  }
  if (!hasValidSurrogatePairs(value)) {
    throw new InvalidReplaceError(`${name} must contain valid Unicode.`);
  }
}

function hasValidSurrogatePairs(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

function planReplacement(originalText: string, input: Required<ReplaceToolInput>): ReplacementPlan {
  const hasBom = originalText.startsWith(UTF8_BOM);
  const searchableBody = hasBom ? originalText.slice(1) : originalText;
  const outputNewline = detectOutputNewline(searchableBody);
  const canonicalBody = canonicalizeNewlines(searchableBody);
  const matchIndexes = findReplacementOccurrences(canonicalBody, input.old_string);
  const occurrenceCount = matchIndexes.length;

  if (occurrenceCount === 0) {
    throw new ReplaceNotFoundError("Found 0 occurrences. Reread the file before retrying.");
  }
  if (!input.replace_all && occurrenceCount > 1) {
    throw new ReplaceAmbiguousError(
      `Found ${occurrenceCount} occurrences. Include more unchanged context or set replace_all to true.`,
    );
  }

  const indexesToReplace = input.replace_all ? matchIndexes : matchIndexes.slice(0, 1);
  const canonicalResult = applyLiteralReplacements(
    canonicalBody,
    indexesToReplace,
    input.old_string.length,
    input.new_string,
  );
  const serializedBody = outputNewline === "\r\n"
    ? canonicalResult.replace(/\n/g, "\r\n")
    : canonicalResult;

  return {
    occurrenceCount: indexesToReplace.length,
    serializedResult: `${hasBom ? UTF8_BOM : ""}${serializedBody}`,
  };
}

function findReplacementOccurrences(content: string, oldString: string): number[] {
  const indexes: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= content.length - oldString.length) {
    const matchIndex = content.indexOf(oldString, searchFrom);
    if (matchIndex === -1) break;
    indexes.push(matchIndex);
    searchFrom = matchIndex + oldString.length;
  }
  return indexes;
}

function applyLiteralReplacements(
  content: string,
  matchIndexes: readonly number[],
  matchLength: number,
  replacement: string,
): string {
  const parts: string[] = [];
  let copiedThrough = 0;
  for (const matchIndex of matchIndexes) {
    parts.push(content.slice(copiedThrough, matchIndex), replacement);
    copiedThrough = matchIndex + matchLength;
  }
  parts.push(content.slice(copiedThrough));
  return parts.join("");
}

function canonicalizeNewlines(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

function detectOutputNewline(text: string): "\n" | "\r\n" {
  const firstNewline = text.match(/\r\n|\n|\r/)?.[0];
  return firstNewline === "\r\n" ? "\r\n" : "\n";
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Cancelled");
}

function hasNodeFilesystemErrorCode(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^E[A-Z0-9_]+$/.test(error.code);
}

function boundedErrorCause(error: unknown): string {
  const cause = error instanceof Error ? error.message : String(error);
  const firstLine = cause.split(/\r\n|\n|\r/, 1)[0] ?? "Unknown write failure";
  if (firstLine.length <= MAX_WRITE_ERROR_CAUSE_CHARACTERS) return firstLine;
  return `${firstLine.slice(
    0,
    MAX_WRITE_ERROR_CAUSE_CHARACTERS - WRITE_ERROR_OMISSION_MARKER.length,
  )}${WRITE_ERROR_OMISSION_MARKER}`;
}
