import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashLine } from "../src/api.js";
import { hashModeReadTool, readHashTool } from "../src/tools/locator-read.js";

const makeTempDir = () => mkdtemp(join(tmpdir(), "pi-locator-patch-"));

const firstText = (result: Awaited<ReturnType<typeof readHashTool.execute>>) => {
  const content = result.content[0];
  if (content.type !== "text") {
    throw new Error("Expected first content item to be text");
  }
  return content.text;
};

const renderText = (component: { render: (width: number) => string[] }) => component.render(200).join("\n").trimEnd();

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`
};

describe("read_hash tool", () => {
  it("is agent-visible as read_hash and returns variable HASH│content rows", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "file.txt"), "short\n\nconst enabled = true;\nfunction parsePatchOp(line: string): PatchOp {\n");

    const result = await readHashTool.execute("tool-call", { path: "file.txt" }, undefined, undefined, { cwd: dir } as never);

    expect(readHashTool.name).toBe("read_hash");
    expect(firstText(result)).toBe([
      "│short",
      "│",
      `${hashLine("const enabled = true;").slice(0, 3)}│const enabled = true;`,
      `${hashLine("function parsePatchOp(line: string): PatchOp {")}│function parsePatchOp(line: string): PatchOp {`
    ].join("\n"));
  });

  it("uses the built-in read result renderer while keeping a read_hash call label", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "file"), "short\nconst enabled = true;\n");
    const args = { path: "file" };
    const result = await readHashTool.execute("tool-call", args, undefined, undefined, { cwd: dir } as never);
    const context = {
      args,
      cwd: dir,
      lastComponent: undefined,
      showImages: false,
      isError: false
    } as never;

    const callText = renderText(readHashTool.renderCall?.(args, theme as never, context) as never);
    const collapsedResult = renderText(
      readHashTool.renderResult?.(result, { expanded: false, isPartial: false }, theme as never, context) as never
    );
    const expandedResult = renderText(
      readHashTool.renderResult?.(result, { expanded: true, isPartial: false }, theme as never, context) as never
    );

    expect(callText).toContain("read_hash");
    expect(callText).not.toContain("<b>read</b>");
    expect(collapsedResult).toBe("");
    expect(expandedResult).toContain("│short");
    expect(expandedResult).toContain(`${hashLine("const enabled = true;").slice(0, 3)}│const enabled = true;`);
  });

  it("can expose the same hash reader as read for hash mode", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "file"), "const enabled = true;\n");
    const args = { path: "file" };
    const result = await hashModeReadTool.execute("tool-call", args, undefined, undefined, { cwd: dir } as never);
    const context = {
      args,
      cwd: dir,
      lastComponent: undefined,
      showImages: false,
      isError: false
    } as never;

    const callText = renderText(hashModeReadTool.renderCall?.(args, theme as never, context) as never);

    expect(hashModeReadTool.name).toBe("read");
    expect(callText).toContain("<b>read</b>");
    expect(callText).not.toContain("read_hash");
    expect(firstText(result)).toBe(`${hashLine("const enabled = true;").slice(0, 3)}│const enabled = true;`);
  });
});
