import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { OutputTooLargeError } from "./errors.js";

export const LLM_VISIBLE_OUTPUT_MAX_BYTES = PiCodingAgent.DEFAULT_MAX_BYTES;

// Pi's documented visible-output cap is 2000 lines; keep fallback for older Pi builds without the export.
const LOCAL_DEFAULT_MAX_LINES = 2000;
const piDefaultMaxLines = (PiCodingAgent as { DEFAULT_MAX_LINES?: unknown }).DEFAULT_MAX_LINES;
export const LLM_VISIBLE_OUTPUT_MAX_LINES =
  typeof piDefaultMaxLines === "number" ? piDefaultMaxLines : LOCAL_DEFAULT_MAX_LINES;

type HashlineToolName = "read" | "read_hash" | "edit";

export interface VisibleOutputOverflow {
  kind: "lines" | "bytes";
  actual: string;
  max: string;
}

export function assertHashlineOutputFits(
  toolName: HashlineToolName,
  renderedOutput: string,
  renderedLineCount = countRenderedLines(renderedOutput)
): void {
  const overflow = getVisibleOutputOverflow(renderedOutput, renderedLineCount);
  if (overflow) {
    throw outputTooLargeError(toolName, overflow);
  }
}

export function getVisibleOutputOverflow(
  renderedOutput: string,
  renderedLineCount = countRenderedLines(renderedOutput)
): VisibleOutputOverflow | undefined {
  if (renderedLineCount > LLM_VISIBLE_OUTPUT_MAX_LINES) {
    return { kind: "lines", actual: `${renderedLineCount} lines`, max: `${LLM_VISIBLE_OUTPUT_MAX_LINES} lines` };
  }

  const byteLength = Buffer.byteLength(renderedOutput, "utf8");
  if (byteLength > LLM_VISIBLE_OUTPUT_MAX_BYTES) {
    return { kind: "bytes", actual: `${byteLength} bytes`, max: `${LLM_VISIBLE_OUTPUT_MAX_BYTES} bytes` };
  }

  return undefined;
}

export function countRenderedLines(renderedOutput: string): number {
  return renderedOutput === "" ? 0 : renderedOutput.split("\n").length;
}

function outputTooLargeError(toolName: HashlineToolName, overflow: VisibleOutputOverflow): OutputTooLargeError {
  if (toolName === "read" || toolName === "read_hash") {
    return new OutputTooLargeError(
      `${toolName} output is ${overflow.actual}, exceeding ${overflow.max}. Use a lower limit and/or different offset to paginate; no file was written.`
    );
  }

  return new OutputTooLargeError(
    `edit visible receipt is ${overflow.actual}, exceeding ${overflow.max}. Edit was not written by this guard.`
  );
}
