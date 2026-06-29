import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashLine, parseText } from "../src/api.js";
import { patchTool } from "../src/tools/locator-patch.js";

const makePlainTempDir = () => mkdtemp(join(tmpdir(), "pi-locator-patch-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousHashMode = process.env.PI_LOCATOR_PATCH_HASH_MODE;

afterEach(() => {
  restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
  restoreEnv("PI_LOCATOR_PATCH_HASH_MODE", previousHashMode);
});

async function makeTempDir() {
  const dir = await makePlainTempDir();
  const agentDir = join(dir, "agent");
  const configDir = join(agentDir, "extensions", "pi-locator-patch");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ hashMode: true }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
const row = (prefix: " " | "-" | "+", content: string) => prefix === "+" ? `${prefix}${content}` : `${prefix}#${hashLine(content)}`;
const hashContext = (content: string) => ` ${hashLine(content)}`;
const resultText = (result: Awaited<ReturnType<typeof patchTool.execute>>) => {
  const content = result.content[0];
  if (content.type !== "text") {
    throw new Error("Expected text content");
  }
  return content.text;
};
const detailsDiff = (result: Awaited<ReturnType<typeof patchTool.execute>>) => (result.details as { diff: string }).diff;
const detailsCharEfficiency = (result: Awaited<ReturnType<typeof patchTool.execute>>) =>
  (result.details as { charEfficiency: { patchChars: number; baselineChars: number } }).charEfficiency;
const patchParameterDescription = () => {
  const parameters = patchTool.parameters as { properties: { patch: { description?: string } } };
  return parameters.properties.patch.description ?? "";
};
const retryPatchPathFrom = (message: string) => {
  const match = /^Retry patch: (.+)$/m.exec(message);
  if (!match) {
    throw new Error(`Missing retry patch path in: ${message}`);
  }
  return match[1];
};

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected rejection");
}

async function patchFile(initialText: string, diff: string, path = "file.txt") {
  const dir = await makeTempDir();
  const file = join(dir, path);
  await writeFile(file, initialText);
  const result = await patchTool.execute(
    "tool-call",
    { patch: diff.startsWith("*** Begin Patch") ? diff : ["*** Begin Patch", `*** Update File: ${path}`, diff, "*** End Patch"].join("\n") },
    undefined,
    undefined,
    { cwd: dir } as never
  );
  return { dir, file, result };
}

describe("patch visible status", () => {
  it("keeps XML tag text aligned with its enclosing tag", () => {
    const description = patchParameterDescription();

    expect(description).toContain("<description>\nInline patch text.");
    expect(description).not.toContain("<description>\n  Inline patch text.");
    expect(description).toMatch(/^ {4}<content>\n {4}aaaaaaaaaab\n {4}aaaaacaaaaa\n {4}bbbbbbbbbba\n {4}<\/content>/m);
    expect(description).not.toMatch(/^ {4}<content>\n {6}aaaaaaaaaab/m);
    expect(description).toMatch(/^ {4}@@\n {5}:before\n {5}:\n {4}-:\n {5}:after\n {4}\+\n {4}\*\*\* End Patch/m);
  });

  it("is agent-visible as a hash receipt with context and inserted lines only", async () => {
    const diff = ["@@", row(" ", "a"), row("-", "old"), row("+", "new"), row(" ", "z")].join("\n");

    const { file, result } = await patchFile("a\nold\nz\n", diff);

    expect(patchTool.name).toBe("patch");
    expect(resultText(result)).toBe(["*** Update File: file.txt", "@@ matched line 1 @@", hashContext("a"), `+${hashLine("new")}`, hashContext("z")].join("\n"));
    expect(resultText(result)).not.toContain(hashLine("old"));
    expect(resultText(result)).not.toContain("old");
    await expect(readFile(file, "utf8")).resolves.toBe("a\nnew\nz\n");
  });

  it("keeps compact status by default when hash mode is not configured", async () => {
    const previous = process.env.PI_LOCATOR_PATCH_HASH_MODE;
    process.env.PI_LOCATOR_PATCH_HASH_MODE = "0";
    try {
      const dir = await makePlainTempDir();
      const file = join(dir, "file.txt");
      await writeFile(file, "old");
      const patch = ["*** Begin Patch", "*** Update File: file.txt", "@@", row("-", "old"), row("+", "new"), "*** End Patch"].join("\n");

      const result = await patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never);

      expect(resultText(result)).toBe(["*** Update File: file.txt", "Applied"].join("\n"));
      await expect(readFile(file, "utf8")).resolves.toBe("new");
    } finally {
      if (previous === undefined) delete process.env.PI_LOCATOR_PATCH_HASH_MODE;
      else process.env.PI_LOCATOR_PATCH_HASH_MODE = previous;
    }
  });

  it("applies update hunks with text-only locators", async () => {
    const diff = ["@@", " :a", "-:old", "+new", " :z"].join("\n");

    const { file, result } = await patchFile("a\nold\nz\n", diff);

    expect(resultText(result)).toContain(`+${hashLine("new")}`);
    await expect(readFile(file, "utf8")).resolves.toBe("a\nnew\nz\n");
  });

  it("returns applied patch transcript in details.diff", async () => {
    const universal = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      row("-", "old"),
      row("+", "new"),
      "*** End Patch"
    ].join("\n");

    const { result } = await patchFile("old", universal);

    expect(resultText(result)).not.toContain("old");
    expect(resultText(result)).toContain(`+${hashLine("new")}`);
    expect(detailsDiff(result)).toContain("--- a/file.txt");
    expect(detailsDiff(result)).toContain("+++ b/file.txt");
    expect(detailsDiff(result)).toContain("-old");
    expect(detailsDiff(result)).toContain("+new");
  });
  it("reports patch chars against unified-diff baseline chars", async () => {
    const universal = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      "-^old",
      "+new",
      "*** End Patch"
    ].join("\n");

    const { result } = await patchFile("old text", universal);

    expect(detailsCharEfficiency(result)).toEqual({ patchChars: 9, baselineChars: 13 });
  });
  it("counts authored combined locator whitespace and blank unified-diff rows", async () => {
    const combinedPatch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      "-?{\"prefix\": \"old\"}",
      "+new",
      "*** End Patch"
    ].join("\n");
    const blankContextPatch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      "",
      "-old",
      "+new",
      "*** End Patch"
    ].join("\n");

    const { result: combinedResult } = await patchFile("old text", combinedPatch);
    const { result: blankContextResult } = await patchFile("\nold", blankContextPatch);

    expect(detailsCharEfficiency(combinedResult)).toEqual({ patchChars: 23, baselineChars: 13 });
    expect(detailsCharEfficiency(blankContextResult)).toEqual({ patchChars: 8, baselineChars: 9 });
  });
  it("reports char efficiency for add, delete, range, and dry-run changes", async () => {
    const addDir = await makeTempDir();
    const addPatch = ["*** Begin Patch", "*** Add File: added.txt", "+hello", "+world", "*** End Patch"].join("\n");
    const addResult = await patchTool.execute("tool-call", { patch: addPatch }, undefined, undefined, { cwd: addDir } as never);

    const deleteDir = await makeTempDir();
    await writeFile(join(deleteDir, "delete.txt"), "a\nbb");
    const deletePatch = ["*** Begin Patch", "*** Delete File: delete.txt", "*** End Patch"].join("\n");
    const deleteResult = await patchTool.execute("tool-call", { patch: deletePatch }, undefined, undefined, { cwd: deleteDir } as never);

    const rangeDir = await makeTempDir();
    await writeFile(join(rangeDir, "range.txt"), "a\nb\nc\nd");
    const rangePatch = ["*** Begin Patch", "*** Update File: range.txt", "@@", " ^a", "-...", " ^d", "*** End Patch"].join("\n");
    const rangeResult = await patchTool.execute("tool-call", { patch: rangePatch, dry_run: true }, undefined, undefined, { cwd: rangeDir } as never);

    expect(detailsCharEfficiency(addResult)).toEqual({ patchChars: 12, baselineChars: 12 });
    expect(detailsCharEfficiency(deleteResult)).toEqual({ patchChars: 0, baselineChars: 5 });
    expect(detailsCharEfficiency(rangeResult)).toEqual({ patchChars: 10, baselineChars: 8 });
    await expect(readFile(join(rangeDir, "range.txt"), "utf8")).resolves.toBe("a\nb\nc\nd");
  });
  it("does not expand update details to the whole file", async () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line-${index}`);
    const universal = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      row(" ", "line-49"),
      row("-", "line-50"),
      row("+", "changed"),
      row(" ", "line-51"),
      "*** End Patch"
    ].join("\n");

    const { result } = await patchFile(lines.join("\n"), universal);
    const diff = detailsDiff(result);

    expect(diff).toContain("@@ matched line 50 @@");
    expect(diff).toContain(" line-49");
    expect(diff).toContain("-line-50");
    expect(diff).toContain("+changed");
    expect(diff).toContain(" line-51");
    expect(diff).not.toContain("line-0");
    expect(diff.split("\n")).toHaveLength(7);
  });

  it("adds a new file from a universal Add File section and shows inserted rows", async () => {
    const dir = await makeTempDir();
    const patch = ["*** Begin Patch", "*** Add File: added.txt", "+hello", "+world", "*** End Patch"].join("\n");

    const result = await patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never);

    expect(resultText(result)).toBe(["*** Add File: added.txt", "@@ add file @@", `+${hashLine("hello")}`, `+${hashLine("world")}`].join("\n"));
    expect(detailsDiff(result)).toContain("--- /dev/null");
    expect(detailsDiff(result)).toContain("+++ b/added.txt");
    expect(detailsDiff(result)).toContain("+hello");
    await expect(readFile(join(dir, "added.txt"), "utf8")).resolves.toBe("hello\nworld");
  });

  it("allows hashline-looking inserted content as literal file content", async () => {
    const dir = await makeTempDir();
    const literal = `${hashLine("not the line")}│literal content`;
    const shortHashLiteral = `${hashLine("another line").slice(0, 3)}│short hash literal`;
    const patch = ["*** Begin Patch", "*** Add File: literal.txt", `+${literal}`, `+${shortHashLiteral}`, "*** End Patch"].join("\n");

    const result = await patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never);

    expect(resultText(result)).toContain(`+${hashLine(literal)}`);
    await expect(readFile(join(dir, "literal.txt"), "utf8")).resolves.toBe(`${literal}\n${shortHashLiteral}`);
  });

  it("rejects Add File when target already exists", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "added.txt"), "already");
    const patch = ["*** Begin Patch", "*** Add File: added.txt", "+new", "*** End Patch"].join("\n");

    await expect(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never)).rejects.toThrow("[E_FILE_TEXT]");
    await expect(readFile(join(dir, "added.txt"), "utf8")).resolves.toBe("already");
  });

  it("writes Add File blank lines so status, diff, and file bytes agree", async () => {
    const dir = await makeTempDir();
    const patch = ["*** Begin Patch", "*** Add File: blank.txt", "+", "*** End Patch"].join("\n");

    const result = await patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never);
    const writtenText = await readFile(join(dir, "blank.txt"), "utf8");

    expect(writtenText).toBe("\n");
    expect(parseText(writtenText).lines).toEqual([""]);
    expect(resultText(result)).toBe(["*** Add File: blank.txt", "@@ add file @@", `+${hashLine("")}`].join("\n"));
    expect(detailsDiff(result).split("\n").at(-1)).toBe("+");
  });

  it("preserves Add File trailing blank rows in bytes, status, and details diff", async () => {
    const dir = await makeTempDir();
    const patch = ["*** Begin Patch", "*** Add File: trailing.txt", "+hello", "+", "*** End Patch"].join("\n");

    const result = await patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never);
    const writtenText = await readFile(join(dir, "trailing.txt"), "utf8");

    expect(writtenText).toBe("hello\n\n");
    expect(parseText(writtenText).lines).toEqual(["hello", ""]);
    expect(resultText(result).split("\n").slice(-2)).toEqual([`+${hashLine("hello")}`, `+${hashLine("")}`]);
    expect(detailsDiff(result).split("\n").slice(-2)).toEqual(["+hello", "+"]);
  });

  it("keeps earlier aliased Add File success and writes failed-tail retry patch", async () => {
    const dir = await makeTempDir();
    const patch = [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+first",
      "*** Add File: ./a.txt",
      "+second",
      "*** End Patch"
    ].join("\n");

    const message = await rejectionMessage(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never));
    expect(message).toContain("[E_PARTIAL_PATCH]");
    expect(message).toContain("Applied:\n*** Add File: a.txt");
    expect(message).toContain("Failed:\n*** Add File: ./a.txt");
    await expect(readFile(join(dir, "a.txt"), "utf8")).resolves.toBe("first");
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toBe([
      "*** Begin Patch",
      "*** Add File: ./a.txt",
      "+second",
      "*** End Patch"
    ].join("\n"));
  });

  it("keeps earlier aliased Update File success and writes failed-tail retry patch", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      row("-", "old"),
      row("+", "first"),
      "*** Update File: ./a.txt",
      "@@",
      row("-", "old"),
      row("+", "second"),
      "*** End Patch"
    ].join("\n");

    const message = await rejectionMessage(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never));
    expect(message).toContain("[E_PARTIAL_PATCH]");
    expect(message).toContain("Failed:\n*** Update File: ./a.txt");
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toContain("*** Update File: ./a.txt");
    await expect(readFile(join(dir, "a.txt"), "utf8")).resolves.toBe("first");
  });

  it("reports stale hunk failures by patch line without echoing locator text", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.txt"), "present");
    const longLocator = "missing locator text that should not be repeated";
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      `-:${longLocator}`,
      "+replacement",
      "*** End Patch"
    ].join("\n");

    const message = await rejectionMessage(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never));
    expect(message).toContain("[E_STALE_HUNK] Line 4: Hunk 1 not found.");
    expect(message).not.toContain("match pattern");
    expect(message).not.toContain(longLocator);
  });

  it("keeps earlier aliased Delete File success and writes failed-tail retry patch", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "doomed.txt");
    await writeFile(target, "bye");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: doomed.txt",
      "*** Delete File: ./doomed.txt",
      "*** End Patch"
    ].join("\n");

    const message = await rejectionMessage(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never));
    expect(message).toContain("[E_PARTIAL_PATCH]");
    expect(message).toContain("Failed:\n*** Delete File: ./doomed.txt");
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toContain("*** Delete File: ./doomed.txt");
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("keeps earlier edits when a later file operation fails", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "one.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      row("-", "old"),
      row("+", "new"),
      "*** Add File: missing-parent/two.txt",
      "+second",
      "*** End Patch"
    ].join("\n");

    const message = await rejectionMessage(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never));
    expect(message).toContain("[E_PARTIAL_PATCH]");
    expect(message).toContain("Applied:\n*** Update File: one.txt");
    expect(message).toContain("Failed:\n*** Add File: missing-parent/two.txt");
    await expect(readFile(join(dir, "one.txt"), "utf8")).resolves.toBe("new");
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toBe([
      "*** Begin Patch",
      "*** Add File: missing-parent/two.txt",
      "+second",
      "*** End Patch"
    ].join("\n"));
  });

  it("keeps earlier additions when a later delete target fails", async () => {
    const dir = await makeTempDir();
    const patch = [
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+new",
      "*** Delete File: missing.txt",
      "*** End Patch"
    ].join("\n");

    const message = await rejectionMessage(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never));
    expect(message).toContain("[E_PARTIAL_PATCH]");
    expect(message).toContain("Applied:\n*** Add File: created.txt");
    expect(message).toContain("Failed:\n*** Delete File: missing.txt");
    await expect(stat(join(dir, "created.txt"))).resolves.toBeTruthy();
  });

  it("writes a raw retry patch when syntax parsing fails", async () => {
    const dir = await makeTempDir();
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "old raw context"
    ].join("\n");

    const message = await rejectionMessage(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never));
    expect(message).toContain("[E_INVALID_PATCH]");
    expect(message).toContain("Retry patch:");
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toBe(patch);
  });

  it("dry_run validates the whole patch without writing earlier valid operations", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "one.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      row("-", "old"),
      row("+", "new"),
      "*** Add File: missing-parent/two.txt",
      "+second",
      "*** End Patch"
    ].join("\n");

    await expect(patchTool.execute("tool-call", { patch, dry_run: true }, undefined, undefined, { cwd: dir } as never)).rejects.toThrow("[E_FILE_TEXT]");
    await expect(readFile(join(dir, "one.txt"), "utf8")).resolves.toBe("old");
  });

  it("dry_run simulates sequential aliases without writing", async () => {
    const dir = await makeTempDir();
    const patch = [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+first",
      "*** Update File: ./a.txt",
      "@@",
      row("-", "first"),
      row("+", "second"),
      "*** End Patch"
    ].join("\n");

    const result = await patchTool.execute("tool-call", { patch, dry_run: true }, undefined, undefined, { cwd: dir } as never);

    expect(resultText(result)).toContain("*** Add File: a.txt");
    expect(resultText(result)).toContain("*** Update File: ./a.txt");
    await expect(stat(join(dir, "a.txt"))).rejects.toThrow();
  });

  it("applies repeated update sections for the same file sequentially", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "one.txt"), "first");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      row(" ", "first"),
      row("+", "second"),
      "*** Update File: one.txt",
      "@@",
      row(" ", "second"),
      row("+", "third"),
      "*** End Patch"
    ].join("\n");

    await patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never);

    await expect(readFile(join(dir, "one.txt"), "utf8")).resolves.toBe("first\nsecond\nthird");
  });

  it("applies a multi-file patch", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "one.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
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

  it("accepts patch_file instead of inline patch", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "one.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      row("-", "old"),
      row("+", "new"),
      "*** End Patch"
    ].join("\n");
    const patchPath = join(dir, "change.patch");
    await writeFile(patchPath, patch);

    const result = await patchTool.execute("tool-call", { patch_file: "change.patch" }, undefined, undefined, { cwd: dir } as never);

    expect(resultText(result)).toContain("*** Update File: one.txt");
    await expect(readFile(join(dir, "one.txt"), "utf8")).resolves.toBe("new");
  });

  it("rejects ambiguous patch sources", async () => {
    const dir = await makeTempDir();
    const patch = ["*** Begin Patch", "*** Add File: a.txt", "+a", "*** End Patch"].join("\n");
    await writeFile(join(dir, "change.patch"), patch);

    await expect(patchTool.execute("tool-call", { patch, patch_file: "change.patch" }, undefined, undefined, { cwd: dir } as never)).rejects.toThrow("[E_INVALID_PATCH]");
    await expect(patchTool.execute("tool-call", { patch_file: "missing.patch" }, undefined, undefined, { cwd: dir } as never)).rejects.toThrow("[E_FILE_TEXT]");
    await expect(patchTool.execute("tool-call", {}, undefined, undefined, { cwd: dir } as never)).rejects.toThrow("[E_INVALID_PATCH]");
  });

  it("hard-deletes a file with a Codex Delete File section", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "doomed.txt");
    await writeFile(target, "a\nb");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: doomed.txt",
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

  it("rejects Delete File sections with a body", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "doomed.txt");
    await writeFile(target, "a\nb");
    const patch = ["*** Begin Patch", "*** Delete File: doomed.txt", "@@", row("-", "a"), "*** End Patch"].join("\n");

    await expect(patchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never)).rejects.toThrow("[E_INVALID_PATCH]");
    await expect(readFile(target, "utf8")).resolves.toBe("a\nb");
  });

  it("falls back to compact status when hash receipt has too many inserted rows", async () => {
    const manyLines = Array.from({ length: 2100 }, (_, index) => `line-${index}`);
    const universal = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      row("-", "old"),
      ...manyLines.map((line) => row("+", line)),
      "*** End Patch"
    ].join("\n");

    const { file, result } = await patchFile("old", universal);

    expect(resultText(result)).toBe(["*** Update File: file.txt", "Applied"].join("\n"));
    expect(resultText(result)).not.toContain("line-1");
    await expect(readFile(file, "utf8")).resolves.toBe(manyLines.join("\n"));
  });

  it("omits empty statuses", async () => {
    const diff = ["@@", row("-", "only")].join("\n");

    const { file, result } = await patchFile("only", diff);

    expect(resultText(result)).toBe(["*** Update File: file.txt", "@@ matched line 1 @@"].join("\n"));
    await expect(readFile(file, "utf8")).resolves.toBe("");
  });
});
