import { createReadToolDefinition, defineTool, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readExistingTextFile, resolveToolPath } from "../fs-text.js";
import { assertHashlineOutputFits, LLM_VISIBLE_OUTPUT_MAX_LINES } from "../output-size.js";
import { renderHashLines, toHashLines } from "../read-format.js";
import { parseText } from "../text-lines.js";

const MAX_LIMIT = LLM_VISIBLE_OUTPUT_MAX_LINES;
const renderBuiltInReadResult = createReadToolDefinition(process.cwd()).renderResult;

type ReadHashRenderArgs = { path?: string; offset?: number; limit?: number };
type SelectorReadToolName = "read" | "read_hash";

function formatReadHashCall(args: ReadHashRenderArgs, theme: Pick<Theme, "fg" | "bold">, toolName: SelectorReadToolName): string {
  const startLine = args.offset ?? 1;
  const endLine = args.limit !== undefined ? startLine + args.limit - 1 : undefined;
  const range =
    args.offset !== undefined || args.limit !== undefined
      ? theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`)
      : "";
  return `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", args.path ?? "")}${range}`;
}

function createSelectorReadTool(toolName: SelectorReadToolName) {
  return defineTool({
    name: toolName,
    label: toolName === "read" ? "Read" : "Read Hash",
    description: "Read text lines for patching. Lines render as 1- to 4-character HASH│content, with hash width chosen from line entropy.",
    parameters: Type.Object(
      {
        path: Type.String({ description: "Text file path to read." }),
        offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based logical line offset." })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: "Max logical lines to return." }))
      },
      { additionalProperties: false }
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("Cancelled");
      }

      const offset = params.offset ?? 1;
      const limit = params.limit ?? MAX_LIMIT;
      const { path, text } = await readExistingTextFile(resolveToolPath(ctx.cwd, params.path));
      const model = parseText(text);
      const selected = model.lines.slice(offset - 1, offset - 1 + limit);
      const renderedText = renderHashLines(toHashLines(selected));
      assertHashlineOutputFits(toolName, renderedText, selected.length);

      return {
        content: [{ type: "text", text: renderedText }],
        details: {
          path,
          offset,
          limit,
          lineCount: model.lines.length,
          returnedLineCount: selected.length,
          hasMore: offset - 1 + limit < model.lines.length
        }
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatReadHashCall(args, theme, toolName));
      return text;
    },
    // Reuse built-in read result rendering so read_hash/read collapses, expands,
    // highlights, and truncation-displays like normal file reads in the TUI.
    renderResult(result, options, theme, context) {
      return renderBuiltInReadResult?.(result as never, options, theme, context as never) ?? new Text("", 0, 0);
    }
  });
}

export const readHashTool = createSelectorReadTool("read_hash");
export const hashProfileReadTool = createSelectorReadTool("read");
