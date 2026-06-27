import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readExistingTextFile, resolveToolPath } from "../fs-text.js";
import { assertHashlineOutputFits, LLM_VISIBLE_OUTPUT_MAX_LINES } from "../output-size.js";
import { renderHashLines, toHashLines } from "../read-format.js";
import { parseText } from "../text-lines.js";

const MAX_LIMIT = LLM_VISIBLE_OUTPUT_MAX_LINES;

export const readHashTool = defineTool({
  name: "read_hash",
  label: "Read Hash",
  description: "Read text lines for patching. Eligible lines render as HASH│content; short or low-entropy lines may render as plain content without a hash.",
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
    assertHashlineOutputFits("read_hash", renderedText, selected.length);

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
  }
});
