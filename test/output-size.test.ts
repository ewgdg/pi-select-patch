import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashLine } from "../src/api.js";
import {
  assertHashlineOutputFits,
  LLM_VISIBLE_OUTPUT_MAX_BYTES,
  LLM_VISIBLE_OUTPUT_MAX_LINES
} from "../src/output-size.js";
import { patchTool } from "../src/tools/locator-patch.js";
import { readTool } from "../src/tools/locator-read.js";

const makeTempDir = () => mkdtemp(join(tmpdir(), "pi-locator-patch-"));
const row = (prefix: "=" | "-" | "+", content: string) => prefix === "+" ? `${prefix}${content}` : `${prefix}#${hashLine(content)}`;
const renderedRow = (content: string) => `${hashLine(content)}│${content}`;
const oversizedContent = () => "x".repeat(LLM_VISIBLE_OUTPUT_MAX_BYTES + 1);
const oneOverLineCap = () => Array.from({ length: LLM_VISIBLE_OUTPUT_MAX_LINES + 1 }, (_, index) => `line-${index}`);
const resultText = (result: Awaited<ReturnType<typeof patchTool.execute>>) => {
  const content = result.content[0];
  if (content.type !== "text") {
    throw new Error("Expected text content");
  }
  return content.text;
};

describe("tool output size guards", () => {
  it("rejects read output for one overlarge line with pagination guidance", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "large.txt");
    await writeFile(file, oversizedContent());

    await expect(
      readTool.execute("tool-call", { path: "large.txt", limit: 1 }, undefined, undefined, { cwd: dir } as never)
    ).rejects.toThrow(/\[E_OUTPUT_TOO_LARGE\].*lower limit.*offset/);
  });

  it("rejects read output when rendered rows exceed the visible line cap", () => {
    const rows = oneOverLineCap();
    const rendered = rows.map(renderedRow).join("\n");

    expect(() => assertHashlineOutputFits("read", rendered, rows.length)).toThrow(
      /\[E_OUTPUT_TOO_LARGE\].*lines.*lower limit.*offset/
    );
  });

  it("rejects overlarge patch guard output without redundant read guidance", () => {
    const rows = oneOverLineCap();
    const rendered = rows.map((content) => `+${hashLine(content)}`).join("\n");

    expect(() => assertHashlineOutputFits("patch", rendered, rows.length)).toThrow(
      /\[E_OUTPUT_TOO_LARGE\].*Patch was not written by this guard\./
    );
    expect(() => assertHashlineOutputFits("patch", rendered, rows.length)).not.toThrow(/Use read to inspect current file hashes/);
  });

  it("writes huge patch result and returns compact receipt instead of full content", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "old");
    const hugeReplacement = oversizedContent();
    const diff = ["*** Begin Patch", "*** Update File: file.txt", "@@", row("-", "old"), row("+", hugeReplacement), "*** End Patch"].join("\n");

    const result = await patchTool.execute(
      "tool-call",
      { patch: diff },
      undefined,
      undefined,
      { cwd: dir } as never
    );

    expect(resultText(result)).toBe(["*** Update File: file.txt", "@@ result", `+${hashLine(hugeReplacement)}`].join("\n"));
    expect(resultText(result)).not.toContain(hugeReplacement);
    await expect(readFile(file, "utf8")).resolves.toBe(hugeReplacement);
  });

  it("writes patch result when receipt exceeds the line cap and returns omitted status", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "old");
    const insertedRows = oneOverLineCap();
    const diff = ["*** Begin Patch", "*** Update File: file.txt", "@@", row("-", "old"), ...insertedRows.map((content) => row("+", content)), "*** End Patch"].join("\n");

    const result = await patchTool.execute(
      "tool-call",
      { patch: diff },
      undefined,
      undefined,
      { cwd: dir } as never
    );

    expect(resultText(result)).toMatch(/Patch applied\. Receipt omitted: .*exceeds visible cap/);
    await expect(readFile(file, "utf8")).resolves.toBe(insertedRows.join("\n"));
  });
});
