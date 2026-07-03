import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashLine, parseText } from "../src/api.js";
import { createPatchTool } from "../src/tools/selector-patch.js";

const smartPatchTool = createPatchTool("smart");
const classicPatchTool = createPatchTool("classic");
const hashPatchTool = createPatchTool("hash");

async function makePlainTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "pi-select-patch-"));
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  delete process.env.PI_SELECT_PATCH_PROFILE;
  return dir;
}

async function makeClassicTempDir() {
  const dir = await makePlainTempDir();
  process.env.PI_SELECT_PATCH_PROFILE = "classic";
  return dir;
}
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousProfile = process.env.PI_SELECT_PATCH_PROFILE;
const previousTmpDir = process.env.TMPDIR;

afterEach(() => {
  restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
  restoreEnv("PI_SELECT_PATCH_PROFILE", previousProfile);
  restoreEnv("TMPDIR", previousTmpDir);
});

async function makeTempDir() {
  const dir = await makePlainTempDir();
  const agentDir = join(dir, "agent");
  const configDir = join(agentDir, "extensions", "pi-select-patch");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({ profile: "hash" }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
const row = (prefix: " " | "-" | "+", content: string) =>
  prefix === "+" ? `${prefix}${content}` : `${prefix}#${hashLine(content)}`;
const hashProfileRow = (prefix: " " | "-" | "+", content: string) =>
  prefix === "+" ? `${prefix}${content}` : `${prefix}${hashLine(content)}`;
const hashContext = (content: string) => ` ${hashLine(content)}`;
const resultText = (result: Awaited<ReturnType<typeof smartPatchTool.execute>>) => {
  const content = result.content[0];
  if (content.type !== "text") {
    throw new Error("Expected text content");
  }
  return content.text;
};
const detailsDiff = (result: Awaited<ReturnType<typeof smartPatchTool.execute>>) =>
  (result.details as { diff: string }).diff;
const detailsCharEfficiency = (
  result: Awaited<ReturnType<typeof smartPatchTool.execute>>,
) =>
  (
    result.details as {
      charEfficiency: { patchChars: number; baselineChars: number };
    }
  ).charEfficiency;
const detailsSelectorEfficiency = (
  result: Awaited<ReturnType<typeof smartPatchTool.execute>>,
) =>
  (
    result.details as {
      selectorEfficiency: { patchChars: number; baselineChars: number };
    }
  ).selectorEfficiency;
const patchParameterDescription = () => {
  const parameters = smartPatchTool.parameters as {
    properties: { patch: { description?: string } };
  };
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
  const dir = await makeClassicTempDir();
  const file = join(dir, path);
  await writeFile(file, initialText);
  const result = await classicPatchTool.execute(
    "tool-call",
    {
      patch: diff.startsWith("*** Begin Patch")
        ? diff
        : [
            "*** Begin Patch",
            `*** Update File: ${path}`,
            diff,
            "*** End Patch",
          ].join("\n"),
      receipt: "hash",
    },
    undefined,
    undefined,
    { cwd: dir } as never,
  );
  return { dir, file, result };
}

describe("patch visible status", () => {
  it("applies patch input starting at the file operation section", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "old\n");

    const result = await hashPatchTool.execute(
      "tool-call",
      {
        patch: [
          "*** Update File: file.txt",
          "@@",
          hashProfileRow("-", "old"),
          hashProfileRow("+", "new"),
        ].join("\n"),
        receipt: "hash",
      },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toContain("*** Update File: file.txt");
    await expect(readFile(file, "utf8")).resolves.toBe("new\n");
  });

  it("keeps profile-specific patch parameter text unindented", () => {
    const description = patchParameterDescription();

    expect(description).toContain("<description>\nInline patch text.");
    expect(description).toContain("### Hunk Match: Smart Profile");
    expect(description).toContain("<file_content>\nThis is a very long long long stable anchor\n</file_content>");
    expect(description).toContain("@@\n a long anchor\n+new line\n</patch>");
    expect(description).not.toContain("<policy>");
    expect(description).not.toContain("markerless_selector");
  });

  it("keeps patch behavior policy in one prompt guideline chunk", () => {
    expect(smartPatchTool.promptGuidelines).toHaveLength(1);
    const guideline = smartPatchTool.promptGuidelines?.[0] ?? "";

    expect(guideline).toContain("<patch_tool_policy>");
    expect(guideline).toContain("Token efficiency is the highest priority");
    expect(guideline).toContain("Use range selector whenever possible");
    expect(guideline).toContain("</patch_tool_policy>");
  });

  it("is agent-visible as a hash receipt with selector cost metric", async () => {
    const diff = [
      "@@",
      row(" ", "a"),
      row("-", "old"),
      row("+", "new"),
      row(" ", "z"),
    ].join("\n");

    const { file, result } = await patchFile("a\nold\nz\n", diff);

    expect(smartPatchTool.name).toBe("patch");
    expect(resultText(result)).toBe(
      [
        "*** Update File: file.txt",
        "@@ matched line 1 @@",
        hashContext("a"),
        `+${hashLine("new")}`,
        hashContext("z"),
        "Selector cost: 225.0%",
      ].join("\n"),
    );
    expect(resultText(result)).not.toContain(hashLine("old"));
    expect(resultText(result)).not.toContain("old");
    await expect(readFile(file, "utf8")).resolves.toBe("a\nnew\nz\n");
  });

  it("keeps compact status by default", async () => {
    const dir = await makePlainTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      "-old",
      row("+", "new"),
      "*** End Patch",
    ].join("\n");

    const result = await smartPatchTool.execute(
      "tool-call",
      { patch },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toBe(
      [
        "*** Update File: file.txt",
        "Applied",
        "Selector cost: 100.0%",
      ].join("\n"),
    );
    await expect(readFile(file, "utf8")).resolves.toBe("new");
  });

  it("treats hash-prefixed update rows as smart text by default", async () => {
    const dir = await makePlainTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "#define X\n#old\n#literal");
    const patch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      " #define X",
      "-#old",
      "+#new",
      " #literal",
      "*** End Patch",
    ].join("\n");

    const result = await smartPatchTool.execute(
      "tool-call",
      { patch },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toBe(
      [
        "*** Update File: file.txt",
        "Applied",
        "Selector cost: 100.0%",
      ].join("\n"),
    );
    await expect(readFile(file, "utf8")).resolves.toBe(
      "#define X\n#new\n#literal",
    );
  });

  it("rejects bare hash-prefixed update rows by default", async () => {
    const dir = await makePlainTempDir();
    await writeFile(join(dir, "file.txt"), "#abc");
    const patch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      "#abc",
      "*** End Patch",
    ].join("\n");

    await expect(
      smartPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    ).rejects.toThrow("[E_INVALID_PATCH]");
  });

  it("uses hash selectors and malformed hash errors in hash profile", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "old");
    const validPatch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      hashProfileRow("-", "old"),
      hashProfileRow("+", "new"),
      "*** End Patch",
    ].join("\n");

    await hashPatchTool.execute(
      "tool-call",
      { patch: validPatch },
      undefined,
      undefined,
      { cwd: dir } as never,
    );
    await expect(readFile(file, "utf8")).resolves.toBe("new");

    const malformedPatch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      " #define X",
      "*** End Patch",
    ].join("\n");
    await expect(
      hashPatchTool.execute(
        "tool-call",
        { patch: malformedPatch },
        undefined,
        undefined,
        { cwd: dir } as never,
      ),
    ).rejects.toThrow("[E_INVALID_PATCH]");
  });

  it("uses the tool's bound smart profile even if config changes before execute", async () => {
    const dir = await makePlainTempDir();
    const agentDir = join(dir, "agent");
    const configDir = join(agentDir, "extensions", "pi-select-patch");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ profile: "hash" }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const file = join(dir, "file.txt");
    await writeFile(file, "anchor line\nold value");
    const patch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      " anchor",
      "-old value",
      "+new value",
      "*** End Patch",
    ].join("\n");

    const result = await smartPatchTool.execute(
      "tool-call",
      { patch },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toBe(
      [
        "*** Update File: file.txt",
        "Applied",
        "Selector cost: 77.3%",
      ].join("\n"),
    );
    await expect(readFile(file, "utf8")).resolves.toBe(
      "anchor line\nnew value",
    );
  });

  it("does not allow per-call row-parsing override in hash profile", async () => {
    const dir = await makePlainTempDir();
    const agentDir = join(dir, "agent");
    const configDir = join(agentDir, "extensions", "pi-select-patch");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ profile: "hash" }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const file = join(dir, "file.txt");
    await writeFile(file, "anchor line\nold value");
    const patch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      " anchor line",
      "-old value",
      "+new value",
      "*** End Patch",
    ].join("\n");

    await expect(
      hashPatchTool.execute(
        "tool-call",
        { patch, receipt: "status" },
        undefined,
        undefined,
        { cwd: dir } as never,
      ),
    ).rejects.toThrow("[E_INVALID_PATCH]");
    await expect(readFile(file, "utf8")).resolves.toBe(
      "anchor line\nold value",
    );
  });

  it("uses hash selectors and hash receipt with the bound hash profile", async () => {
    const dir = await makePlainTempDir();
    const agentDir = join(dir, "agent");
    const configDir = join(agentDir, "extensions", "pi-select-patch");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ profile: "hash" }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const file = join(dir, "file.txt");
    await writeFile(file, "old");
    const oldHash = hashLine("old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      `-${oldHash}`,
      "+new",
      "*** End Patch",
    ].join("\n");

    const result = await hashPatchTool.execute(
      "tool-call",
      { patch },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toBe(
      [
        "*** Update File: file.txt",
        "@@ matched line 1 @@",
        `+${hashLine("new")}`,
        "Selector cost: 125.0%",
      ].join("\n"),
    );
    await expect(readFile(file, "utf8")).resolves.toBe("new");
  });

  it("keeps smart unified-diff rows in retry patches for configured smart defaults", async () => {
    const dir = await makePlainTempDir();
    const agentDir = join(dir, "agent");
    const configDir = join(agentDir, "extensions", "pi-select-patch");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ profile: "smart" }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(join(dir, "a.txt"), "old");
    await writeFile(join(dir, "b.txt"), "present");
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-old",
      "+done",
      "*** Update File: b.txt",
      "@@",
      "-missing",
      "+done",
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      smartPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    );

    await expect(readFile(join(dir, "a.txt"), "utf8")).resolves.toBe("done");
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toBe(
      [
        "*** Begin Patch",
        "*** Update File: b.txt",
        "@@",
        "-missing",
        "+done",
        "*** End Patch",
      ].join("\n"),
    );
  });

  it("copies failed-tail retry patches from authored input instead of serializing", async () => {
    const dir = await makePlainTempDir();
    await writeFile(join(dir, "a.txt"), "old");
    await writeFile(join(dir, "b.txt"), "present");
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-old",
      "+done",
      "*** Update File: b.txt",
      "@@",
      "-missing",
      "+done",
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      smartPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    );

    await expect(readFile(join(dir, "a.txt"), "utf8")).resolves.toBe("done");
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toBe(
      [
        "*** Begin Patch",
        "*** Update File: b.txt",
        "@@",
        "-missing",
        "+done",
        "*** End Patch",
      ].join("\n"),
    );
  });

  it("applies update hunks with text-only selectors", async () => {
    const diff = ["@@", " :a", "-old", "+new", " :z"].join("\n");

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
      "*** End Patch",
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
      "*** End Patch",
    ].join("\n");

    const { result } = await patchFile("old text", universal);

    expect(detailsCharEfficiency(result)).toEqual({
      patchChars: 9,
      baselineChars: 13,
    });
    expect(detailsSelectorEfficiency(result)).toEqual({
      patchChars: 5,
      baselineChars: 9,
    });
  });
  it("counts authored combined selector whitespace and blank unified-diff rows", async () => {
    const combinedPatch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      '-?{"prefix": "old"}',
      "+new",
      "*** End Patch",
    ].join("\n");
    const blankContextPatch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      "",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    const { result: combinedResult } = await patchFile(
      "old text",
      combinedPatch,
    );
    const { result: blankContextResult } = await patchFile(
      "\nold",
      blankContextPatch,
    );

    expect(detailsCharEfficiency(combinedResult)).toEqual({
      patchChars: 23,
      baselineChars: 13,
    });
    expect(detailsCharEfficiency(blankContextResult)).toEqual({
      patchChars: 8,
      baselineChars: 9,
    });
  });
  it("reports char efficiency for add, range, and dry-run changes", async () => {
    const addDir = await makeTempDir();
    const addPatch = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+hello",
      "+world",
      "*** End Patch",
    ].join("\n");
    const addResult = await hashPatchTool.execute(
      "tool-call",
      { patch: addPatch },
      undefined,
      undefined,
      { cwd: addDir } as never,
    );

    const rangeDir = await makePlainTempDir();
    await writeFile(join(rangeDir, "range.txt"), "a\nb\nc\nd");
    const rangePatch = [
      "*** Begin Patch",
      "*** Update File: range.txt",
      "@@",
      " a",
      "-...",
      " d",
      "*** End Patch",
    ].join("\n");
    const rangeResult = await smartPatchTool.execute(
      "tool-call",
      { patch: rangePatch, dry_run: true },
      undefined,
      undefined,
      { cwd: rangeDir } as never,
    );

    expect(detailsCharEfficiency(addResult)).toEqual({
      patchChars: 12,
      baselineChars: 12,
    });
    expect(detailsCharEfficiency(rangeResult)).toEqual({
      patchChars: 8,
      baselineChars: 8,
    });
    expect(detailsSelectorEfficiency(addResult)).toEqual({
      patchChars: 0,
      baselineChars: 0,
    });
    expect(detailsSelectorEfficiency(rangeResult)).toEqual({
      patchChars: 8,
      baselineChars: 8,
    });
    await expect(readFile(join(rangeDir, "range.txt"), "utf8")).resolves.toBe(
      "a\nb\nc\nd",
    );
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
      "*** End Patch",
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
    const patch = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+hello",
      "+world",
      "*** End Patch",
    ].join("\n");

    const result = await hashPatchTool.execute(
      "tool-call",
      { patch },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toBe(
      [
        "*** Add File: added.txt",
        "@@ add file @@",
        `+${hashLine("hello")}`,
        `+${hashLine("world")}`,
      ].join("\n"),
    );
    expect(detailsDiff(result)).toContain("--- /dev/null");
    expect(detailsDiff(result)).toContain("+++ b/added.txt");
    expect(detailsDiff(result)).toContain("+hello");
    await expect(readFile(join(dir, "added.txt"), "utf8")).resolves.toBe(
      "hello\nworld",
    );
  });

  it("allows hashline-looking inserted content as literal file content", async () => {
    const dir = await makeTempDir();
    const literal = `${hashLine("not the line")}│literal content`;
    const shortHashLiteral = `${hashLine("another line").slice(0, 3)}│short hash literal`;
    const patch = [
      "*** Begin Patch",
      "*** Add File: literal.txt",
      `+${literal}`,
      `+${shortHashLiteral}`,
      "*** End Patch",
    ].join("\n");

    const result = await hashPatchTool.execute(
      "tool-call",
      { patch },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toContain(`+${hashLine(literal)}`);
    await expect(readFile(join(dir, "literal.txt"), "utf8")).resolves.toBe(
      `${literal}\n${shortHashLiteral}`,
    );
  });

  it("rejects Add File when target already exists", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "added.txt"), "already");
    const patch = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+new",
      "*** End Patch",
    ].join("\n");

    await expect(
      hashPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    ).rejects.toThrow("[E_FILE_TEXT]");
    await expect(readFile(join(dir, "added.txt"), "utf8")).resolves.toBe(
      "already",
    );
  });

  it("writes Add File blank lines so status, diff, and file bytes agree", async () => {
    const dir = await makeTempDir();
    const patch = [
      "*** Begin Patch",
      "*** Add File: blank.txt",
      "+",
      "*** End Patch",
    ].join("\n");

    const result = await hashPatchTool.execute(
      "tool-call",
      { patch },
      undefined,
      undefined,
      { cwd: dir } as never,
    );
    const writtenText = await readFile(join(dir, "blank.txt"), "utf8");

    expect(writtenText).toBe("\n");
    expect(parseText(writtenText).lines).toEqual([""]);
    expect(resultText(result)).toBe(
      ["*** Add File: blank.txt", "@@ add file @@", `+${hashLine("")}`].join(
        "\n",
      ),
    );
    expect(detailsDiff(result).split("\n").at(-1)).toBe("+");
  });

  it("preserves Add File trailing blank rows in bytes, status, and details diff", async () => {
    const dir = await makeTempDir();
    const patch = [
      "*** Begin Patch",
      "*** Add File: trailing.txt",
      "+hello",
      "+",
      "*** End Patch",
    ].join("\n");

    const result = await hashPatchTool.execute(
      "tool-call",
      { patch },
      undefined,
      undefined,
      { cwd: dir } as never,
    );
    const writtenText = await readFile(join(dir, "trailing.txt"), "utf8");

    expect(writtenText).toBe("hello\n\n");
    expect(parseText(writtenText).lines).toEqual(["hello", ""]);
    expect(resultText(result).split("\n").slice(-2)).toEqual([
      `+${hashLine("hello")}`,
      `+${hashLine("")}`,
    ]);
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
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      hashPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    );
    expect(message).toContain("[E_PARTIAL_PATCH]");
    expect(message).toContain("Applied:\n*** Add File: a.txt");
    expect(message).toContain("Failed:\n*** Add File: ./a.txt");
    await expect(readFile(join(dir, "a.txt"), "utf8")).resolves.toBe("first");
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toBe(
      [
        "*** Begin Patch",
        "*** Add File: ./a.txt",
        "+second",
        "*** End Patch",
      ].join("\n"),
    );
  });

  it("keeps earlier aliased Update File success and writes failed-tail retry patch", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      hashProfileRow("-", "old"),
      hashProfileRow("+", "first"),
      "*** Update File: ./a.txt",
      "@@",
      hashProfileRow("-", "old"),
      hashProfileRow("+", "second"),
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      hashPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    );
    expect(message).toContain("[E_PARTIAL_PATCH]");
    expect(message).toContain("Failed:\n*** Update File: ./a.txt");
    await expect(
      readFile(retryPatchPathFrom(message), "utf8"),
    ).resolves.toContain("*** Update File: ./a.txt");
    await expect(readFile(join(dir, "a.txt"), "utf8")).resolves.toBe("first");
  });

  it("reports stale hunk failures by patch line without echoing selector text", async () => {
    const dir = await makePlainTempDir();
    await writeFile(join(dir, "a.txt"), "present");
    const longSelector = "missing selector text that should not be repeated";
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      `-:${longSelector}`,
      "+replacement",
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      smartPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    );
    expect(message).toContain("[E_STALE_HUNK] Line 4: Hunk not found.");
    expect(message).not.toContain("match pattern");
    expect(message).not.toContain(longSelector);
  });

  it("omits stale hunk numbers because they are local to each Update section", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      hashProfileRow("-", "old"),
      hashProfileRow("+", "new"),
      "*** Update File: a.txt",
      "@@",
      hashProfileRow("-", "absent"),
      hashProfileRow("+", "replacement"),
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      hashPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    );
    expect(message).toContain("[E_STALE_HUNK] Line 8: Hunk not found.");
    expect(message).not.toContain("Hunk 1 not found");
    const retryPatch = await readFile(retryPatchPathFrom(message), "utf8");
    expect(retryPatch).toContain(`-${hashLine("absent")}`);
    expect(retryPatch).not.toContain("-#");
  });

  it("rejects Delete File sections before writing any operation", async () => {
    const dir = await makeTempDir();
    const patch = [
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+new",
      "*** Delete File: doomed.txt",
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      hashPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    );
    expect(message).toContain("[E_INVALID_PATCH] Line 4: Delete File sections are not supported.");
    await expect(stat(join(dir, "created.txt"))).rejects.toThrow();
  });

  it("keeps earlier edits when a later file operation fails", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "one.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      hashProfileRow("-", "old"),
      hashProfileRow("+", "new"),
      "*** Add File: missing-parent/two.txt",
      "+second",
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      hashPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    );
    expect(message).toContain("[E_PARTIAL_PATCH]");
    expect(message).toContain("Applied:\n*** Update File: one.txt");
    expect(message).toContain("Failed:\n*** Add File: missing-parent/two.txt");
    await expect(readFile(join(dir, "one.txt"), "utf8")).resolves.toBe("new");
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toBe(
      [
        "*** Begin Patch",
        "*** Add File: missing-parent/two.txt",
        "+second",
        "*** End Patch",
      ].join("\n"),
    );
  });

  it("writes a raw retry patch when syntax parsing fails", async () => {
    const dir = await makeTempDir();
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "old raw context",
    ].join("\n");

    const message = await rejectionMessage(
      hashPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    );
    expect(message).toContain("[E_INVALID_PATCH]");
    expect(message).toContain("Retry patch:");
    const retryPatchPath = retryPatchPathFrom(message);
    expect(dirname(retryPatchPath)).toBe(join(tmpdir(), "pi-select-patch"));
    expect(basename(retryPatchPath)).toMatch(/^[0-9a-f-]+\.patch$/);
    await expect(readFile(retryPatchPath, "utf8")).resolves.toBe(
      patch,
    );
  });

  it("rejects a closing patch boundary without an opening boundary", async () => {
    const dir = await makeTempDir();
    const patch = [
      "*** Update File: a.txt",
      "@@",
      "-missing",
      "+replacement",
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      hashPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    );

    expect(message).toContain("[E_INVALID_PATCH] Line 5: Patch boundary is incomplete.");
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toBe(patch);
  });

  it("does not let retry patch write failure mask the patch failure", async () => {
    const dir = await makePlainTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "old\n");
    process.env.TMPDIR = join(file, "missing-tmp");

    const message = await rejectionMessage(
      smartPatchTool.execute(
        "tool-call",
        {
          patch: [
            "*** Begin Patch",
            "*** Update File: file.txt",
            "@@",
            "-:absent",
            "*** End Patch",
          ].join("\n"),
        },
        undefined,
        undefined,
        { cwd: dir } as never,
      ),
    );

    expect(message).toContain("[E_STALE_HUNK]");
    expect(message).toContain("Retry patch unavailable:");
    expect(message).not.toContain("Retry patch: ");
  });

  it("dry_run validates the whole patch without writing earlier valid operations", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "one.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      hashProfileRow("-", "old"),
      hashProfileRow("+", "new"),
      "*** Add File: missing-parent/two.txt",
      "+second",
      "*** End Patch",
    ].join("\n");

    await expect(
      hashPatchTool.execute(
        "tool-call",
        { patch, dry_run: true },
        undefined,
        undefined,
        { cwd: dir } as never,
      ),
    ).rejects.toThrow("[E_FILE_TEXT]");
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
      hashProfileRow("-", "first"),
      hashProfileRow("+", "second"),
      "*** End Patch",
    ].join("\n");

    const result = await hashPatchTool.execute(
      "tool-call",
      { patch, dry_run: true },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

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
      hashProfileRow(" ", "first"),
      hashProfileRow("+", "second"),
      "*** Update File: one.txt",
      "@@",
      hashProfileRow(" ", "second"),
      hashProfileRow("+", "third"),
      "*** End Patch",
    ].join("\n");

    await hashPatchTool.execute("tool-call", { patch }, undefined, undefined, {
      cwd: dir,
    } as never);

    await expect(readFile(join(dir, "one.txt"), "utf8")).resolves.toBe(
      "first\nsecond\nthird",
    );
  });

  it("applies a multi-file patch", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "one.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      hashProfileRow("-", "old"),
      hashProfileRow("+", "new"),
      "*** Add File: two.txt",
      "+second",
      "*** End Patch",
    ].join("\n");

    const result = await hashPatchTool.execute(
      "tool-call",
      { patch },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toContain("*** Update File: one.txt");
    expect(resultText(result)).toContain("*** Add File: two.txt");
    await expect(readFile(join(dir, "one.txt"), "utf8")).resolves.toBe("new");
    await expect(readFile(join(dir, "two.txt"), "utf8")).resolves.toBe(
      "second",
    );
  });

  it("accepts patch_file instead of inline patch", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "one.txt"), "old");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      hashProfileRow("-", "old"),
      hashProfileRow("+", "new"),
      "*** End Patch",
    ].join("\n");
    const patchPath = join(dir, "change.patch");
    await writeFile(patchPath, patch);

    const result = await hashPatchTool.execute(
      "tool-call",
      { patch_file: "change.patch" },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toContain("*** Update File: one.txt");
    await expect(readFile(join(dir, "one.txt"), "utf8")).resolves.toBe("new");
  });

  it("rejects ambiguous patch sources", async () => {
    const dir = await makeTempDir();
    const patch = [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+a",
      "*** End Patch",
    ].join("\n");
    await writeFile(join(dir, "change.patch"), patch);

    await expect(
      hashPatchTool.execute(
        "tool-call",
        { patch, patch_file: "change.patch" },
        undefined,
        undefined,
        { cwd: dir } as never,
      ),
    ).rejects.toThrow("[E_INVALID_PATCH]");
    await expect(
      hashPatchTool.execute(
        "tool-call",
        { patch_file: "missing.patch" },
        undefined,
        undefined,
        { cwd: dir } as never,
      ),
    ).rejects.toThrow("[E_FILE_TEXT]");
    await expect(
      hashPatchTool.execute("tool-call", {}, undefined, undefined, {
        cwd: dir,
      } as never),
    ).rejects.toThrow("[E_INVALID_PATCH]");
  });

  it("rejects Delete File sections and leaves files unchanged", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "doomed.txt");
    await writeFile(target, "a\nb");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: doomed.txt",
      "*** End Patch",
    ].join("\n");

    await expect(
      hashPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    ).rejects.toThrow("[E_INVALID_PATCH] Line 2: Delete File sections are not supported.");
    await expect(readFile(target, "utf8")).resolves.toBe("a\nb");
  });

  it("rejects Delete File sections with a body", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "doomed.txt");
    await writeFile(target, "a\nb");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: doomed.txt",
      "@@",
      row("-", "a"),
      "*** End Patch",
    ].join("\n");

    await expect(
      hashPatchTool.execute("tool-call", { patch }, undefined, undefined, {
        cwd: dir,
      } as never),
    ).rejects.toThrow("[E_INVALID_PATCH] Line 2: Delete File sections are not supported.");
    await expect(readFile(target, "utf8")).resolves.toBe("a\nb");
  });

  it("falls back to compact status when hash receipt has too many inserted rows", async () => {
    const manyLines = Array.from(
      { length: 2100 },
      (_, index) => `line-${index}`,
    );
    const universal = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      row("-", "old"),
      ...manyLines.map((line) => row("+", line)),
      "*** End Patch",
    ].join("\n");

    const { file, result } = await patchFile("old", universal);

    expect(resultText(result)).toBe(
      [
        "*** Update File: file.txt",
        "Applied",
        "Selector cost: 150.0%",
      ].join("\n"),
    );
    expect(resultText(result)).not.toContain("line-1");
    await expect(readFile(file, "utf8")).resolves.toBe(manyLines.join("\n"));
  });

  it("omits empty statuses", async () => {
    const diff = ["@@", row("-", "only")].join("\n");

    const { file, result } = await patchFile("only", diff);

    expect(resultText(result)).toBe(
      [
        "*** Update File: file.txt",
        "@@ matched line 1 @@",
        "Selector cost: 120.0%",
      ].join("\n"),
    );
    await expect(readFile(file, "utf8")).resolves.toBe("");
  });
});
