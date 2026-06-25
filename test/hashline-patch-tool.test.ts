import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashLine } from "../src/api.js";
import { patchTool } from "../src/tools/hashline-patch.js";

const makeTempDir = () => mkdtemp(join(tmpdir(), "pi-hashline-patch-"));
const row = (prefix: " " | "-" | "+", content: string) => `${prefix}${hashLine(content)}│${content}`;
const resultText = (result: Awaited<ReturnType<typeof patchTool.execute>>) => {
  const content = result.content[0];
  if (content.type !== "text") {
    throw new Error("Expected text content");
  }
  return content.text;
};
const detailsDiff = (result: Awaited<ReturnType<typeof patchTool.execute>>) => (result.details as { diff: string }).diff;

async function patchFile(initialText: string, diff: string, path = "file.txt") {
  const dir = await makeTempDir();
  const file = join(dir, path);
  await writeFile(file, initialText);
  const result = await patchTool.execute(
    "tool-call",
    { path, patch: diff },
    undefined,
    undefined,
    { cwd: dir } as never
  );
  return { dir, file, result };
}

describe("patch visible receipt", () => {
  it("is agent-visible as patch and returns post-edit hash-only receipt without deleted hashes or file content", async () => {
    const diff = ["@@ @@", row(" ", "a"), row("-", "old"), row("+", "new"), row(" ", "z")].join("\n");

    const { file, result } = await patchFile("a\nold\nz\n", diff);

    expect(patchTool.name).toBe("patch");
    expect(resultText(result)).toBe(
      ["*** Update File: file.txt", "@@ result", ` ${hashLine("a")}`, `+${hashLine("new")}`, ` ${hashLine("z")}`].join("\n")
    );
    expect(resultText(result)).not.toContain(hashLine("old"));
    expect(resultText(result)).not.toContain("old");
    expect(resultText(result)).not.toContain("new");
    await expect(readFile(file, "utf8")).resolves.toBe("a\nnew\nz\n");
  });

  it("returns full content diff only in details.diff", async () => {
    const universal = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@ @@",
      row("-", "old"),
      row("+", "new"),
      "*** End Patch"
    ].join("\n");

    const { result } = await patchFile("old", universal);

    expect(resultText(result)).not.toContain("old");
    expect(resultText(result)).not.toContain("new");
    expect(detailsDiff(result)).toContain("--- a/file.txt");
    expect(detailsDiff(result)).toContain("+++ b/file.txt");
    expect(detailsDiff(result)).toContain("-old");
    expect(detailsDiff(result)).toContain("+new");
  });

  it("adds a new file from a universal Add File section and shows hash-only add receipt", async () => {
    const dir = await makeTempDir();
    const patch = ["*** Begin Patch", "*** Add File: added.txt", "+hello", "+world", "*** End Patch"].join("\n");

    const result = await patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never);

    expect(resultText(result)).toBe(["*** Add File: added.txt", `+${hashLine("hello")}`, `+${hashLine("world")}`].join("\n"));
    expect(resultText(result)).not.toContain("hello");
    expect(resultText(result)).not.toContain("world");
    expect(detailsDiff(result)).toContain("--- /dev/null");
    expect(detailsDiff(result)).toContain("+++ b/added.txt");
    expect(detailsDiff(result)).toContain("+hello");
    await expect(readFile(join(dir, "added.txt"), "utf8")).resolves.toBe("hello\nworld");
  });

  it("rejects Add File when target already exists", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "added.txt"), "already");
    const patch = ["*** Begin Patch", "*** Add File: added.txt", "+new", "*** End Patch"].join("\n");

    await expect(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never)).rejects.toThrow("[E_FILE_TEXT]");
    await expect(readFile(join(dir, "added.txt"), "utf8")).resolves.toBe("already");
  });

  it("validates all files before writing multi-file patches", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "one.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@ @@",
      row("-", "old"),
      row("+", "new"),
      "*** Add File: missing-parent/two.txt",
      "+second",
      "*** End Patch"
    ].join("\n");

    await expect(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never)).rejects.toThrow("[E_FILE_TEXT]");
    await expect(readFile(join(dir, "one.txt"), "utf8")).resolves.toBe("old");
  });

  it("applies a multi-file patch transaction", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "one.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@ @@",
      row("-", "old"),
      row("+", "new"),
      "*** Add File: two.txt",
      "+second",
      "*** End Patch"
    ].join("\n");

    const result = await patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never);

    expect(resultText(result)).toContain("*** Update File: one.txt");
    expect(resultText(result)).toContain("*** Add File: two.txt");
    await expect(readFile(join(dir, "one.txt"), "utf8")).resolves.toBe("new");
    await expect(readFile(join(dir, "two.txt"), "utf8")).resolves.toBe("second");
  });

  it("hard-deletes a file only after complete delete-only hashline evidence", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "doomed.txt");
    await writeFile(target, "a\nb");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: doomed.txt",
      "@@ @@",
      row("-", "a"),
      row("-", "b"),
      "*** End Patch"
    ].join("\n");

    const result = await patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never);

    expect(resultText(result)).toBe(["*** Delete File: doomed.txt", "Deleted file"].join("\n"));
    expect(resultText(result)).not.toContain("a");
    expect(resultText(result)).not.toContain("b");
    expect(detailsDiff(result)).toContain("--- a/doomed.txt");
    expect(detailsDiff(result)).toContain("+++ /dev/null");
    await expect(stat(target)).rejects.toThrow();
  });

  it("rejects Delete File when evidence does not cover the whole file", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "doomed.txt");
    await writeFile(target, "a\nb");
    const patch = ["*** Begin Patch", "*** Delete File: doomed.txt", "@@ @@", row("-", "a"), "*** End Patch"].join("\n");

    await expect(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never)).rejects.toThrow("[E_INVALID_PATCH]");
    await expect(readFile(target, "utf8")).resolves.toBe("a\nb");
  });

  it("omits oversized full-file receipts without exposing inserted content", async () => {
    const manyLines = Array.from({ length: 2100 }, (_, index) => `line-${index}`);
    const universal = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@ @@",
      row("-", "old"),
      ...manyLines.map((line) => row("+", line)),
      "*** End Patch"
    ].join("\n");

    const { file, result } = await patchFile("old", universal);

    expect(resultText(result)).toMatch(/Patch applied\. Receipt omitted: .*Use read/);
    expect(resultText(result)).not.toContain("line-1");
    await expect(readFile(file, "utf8")).resolves.toBe(manyLines.join("\n"));
  });

  it("omits empty receipts and tells caller to use read", async () => {
    const diff = ["@@ @@", row("-", "only")].join("\n");

    const { file, result } = await patchFile("only", diff);

    expect(resultText(result)).toMatch(/Patch applied\. Receipt omitted: no visible hash receipt\. Use read/);
    await expect(readFile(file, "utf8")).resolves.toBe("");
  });
});
