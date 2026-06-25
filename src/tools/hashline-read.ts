import { open, stat } from "node:fs/promises";
import { createReadTool, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readExistingTextFile, resolveToolPath } from "../fs-text.js";
import { assertHashlineOutputFits, LLM_VISIBLE_OUTPUT_MAX_LINES } from "../output-size.js";
import { renderHashLines, toHashLines } from "../read-format.js";
import { parseText } from "../text-lines.js";

const MAX_LIMIT = LLM_VISIBLE_OUTPUT_MAX_LINES;
const IMAGE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export const readTool = defineTool({
  name: "read",
  label: "Hashline Read",
  description: "Read a UTF-8 text file as stable HASH│content lines; image files use Pi's built-in read behavior.",
  promptSnippet: "read returns text files as stable 4-character HASH│content rows for hash-only patching; images are returned by the built-in image reader.",
  promptGuidelines: [
    "Use read before patch only when you do not already know the needed current hashes.",
    "For text files, read output has no line numbers, duplicate counters, or fuzzy anchors.",
    "For image files, read delegates to Pi's built-in image handling instead of returning hashlines."
  ],
  parameters: Type.Object(
    {
      path: Type.String({ description: "Text file path to read as hashlines." }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based logical line offset." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: "Max logical lines to return." }))
    },
    { additionalProperties: false }
  ),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (signal?.aborted) {
      throw new Error("Cancelled");
    }

    const absolutePath = resolveToolPath(ctx.cwd, params.path);
    if (await isSupportedImageFile(absolutePath)) {
      const builtinRead = createReadTool(ctx.cwd);
      const executeBuiltinRead = builtinRead.execute as unknown as (
        toolCallId: string,
        input: typeof params,
        abortSignal: typeof signal,
        onUpdate: typeof _onUpdate,
        context: typeof ctx
      ) => ReturnType<typeof builtinRead.execute>;
      return executeBuiltinRead(_toolCallId, params, signal, _onUpdate, ctx);
    }

    const offset = params.offset ?? 1;
    const limit = params.limit ?? MAX_LIMIT;
    const { path, text } = await readExistingTextFile(absolutePath);
    const model = parseText(text);
    const selected = model.lines.slice(offset - 1, offset - 1 + limit);
    const entries = toHashLines(selected);
    const renderedHashLines = renderHashLines(entries);
    assertHashlineOutputFits("read", renderedHashLines, entries.length);

    return {
      content: [{ type: "text", text: renderedHashLines }],
      details: {
        path,
        offset,
        limit,
        lineCount: model.lines.length,
        returnedLineCount: entries.length,
        hasMore: offset - 1 + limit < model.lines.length
      }
    };
  }
});

async function isSupportedImageFile(path: string): Promise<boolean> {
  const fileStat = await stat(path).catch(() => undefined);
  if (!fileStat?.isFile()) {
    return false;
  }

  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(IMAGE_SNIFF_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return detectSupportedImageMimeType(buffer.subarray(0, bytesRead)) !== null;
  } finally {
    await file.close();
  }
}

function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return buffer[3] === 0xf7 ? null : "image/jpeg";
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
  }
  if (startsWithAscii(buffer, 0, "GIF")) {
    return "image/gif";
  }
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
    return "image/webp";
  }
  return null;
}

function isPng(buffer: Uint8Array): boolean {
  return buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR");
}

function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset: number = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
    if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return false;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  );
}

function startsWith(buffer: Uint8Array, expected: readonly number[]): boolean {
  return buffer.length >= expected.length && expected.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, expected: string): boolean {
  if (buffer.length < offset + expected.length) {
    return false;
  }
  return Array.from(expected).every((char, index) => buffer[offset + index] === char.charCodeAt(0));
}
