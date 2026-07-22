import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashLine, parseText } from "../src/api.js";
import { getVisibleOutputOverflow } from "../src/output-size.js";
import { directTextFilePublicationBackend } from "../src/text-file-publication.js";
import { createPatchTool } from "../src/tools/selector-patch.js";

const smartPatchTool = createPatchTool("smart");
const explicitPatchTool = createPatchTool("explicit");
const hashPatchTool = createPatchTool("hash");
const tolerantExplicitPatchTool = createPatchTool("explicit", "tolerant");

async function makePlainTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "pi-select-patch-"));
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  delete process.env.PI_SELECT_PATCH_PROFILE;
  return dir;
}

async function makeExplicitTempDir() {
  const dir = await makePlainTempDir();
  process.env.PI_SELECT_PATCH_PROFILE = "explicit";
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
  await writeProfileSettings(agentDir, "hash");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return dir;
}

async function writeProfileSettings(
  agentDir: string,
  profile: "explicit" | "smart" | "hash",
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ "pi-select-patch": { profile } }),
  );
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
const detailsPatch = (result: Awaited<ReturnType<typeof smartPatchTool.execute>>) =>
  (result.details as { patch: string }).patch;
const detailsPatchSize = (
  result: Awaited<ReturnType<typeof smartPatchTool.execute>>,
) =>
  (
    result.details as {
      patchSize: { patchChars: number; unifiedDiffChars: number };
    }
  ).patchSize;
const detailsSelectorEfficiency = (
  result: Awaited<ReturnType<typeof smartPatchTool.execute>>,
) =>
  (
    result.details as {
      selectorEfficiency: { patchChars: number; baselineChars: number };
    }
  ).selectorEfficiency;
const detailsHunkAudits = (
  result: Awaited<ReturnType<typeof smartPatchTool.execute>>,
) => (
  result.details as {
    files: Array<{ audit?: { hunkAudits: Array<Record<string, unknown>> } }>;
  }
).files[0]?.audit?.hunkAudits ?? [];
const expectNoSourceOrderWarning = (text: string) => {
  expect(text).not.toMatch(/\b(?:source[- ]order|order[- ]resolution)\b/i);
};
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
  const dir = await makeExplicitTempDir();
  const file = join(dir, path);
  await writeFile(file, initialText);
  const result = await explicitPatchTool.execute(
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

describe("edit publication backend", () => {
  it("routes update and add publication through an injected backend", async () => {
    const dir = await makePlainTempDir();
    await writeFile(join(dir, "existing.txt"), "old");
    const calls: Array<{ operation: "replace" | "create"; path: string; text: string }> = [];
    const tool = createPatchTool("smart", "strict", {
      publicationBackend: {
        async replaceExisting(path, completeText) {
          calls.push({ operation: "replace", path, text: completeText });
          await directTextFilePublicationBackend.replaceExisting(path, completeText);
        },
        async createNew(path, completeText) {
          calls.push({ operation: "create", path, text: completeText });
          await directTextFilePublicationBackend.createNew(path, completeText);
        },
      },
    });

    const result = await tool.execute(
      "tool-call",
      {
        patch: [
          "*** Update File: existing.txt",
          "@@",
          "-old",
          "+new",
          "*** Add File: added.txt",
          "+created",
        ].join("\n"),
      },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toBe([
      "*** Update File: existing.txt",
      "Applied",
      "*** Add File: added.txt",
      "Applied",
    ].join("\n"));
    expect(calls).toEqual([
      { operation: "replace", path: join(dir, "existing.txt"), text: "new" },
      { operation: "create", path: join(dir, "added.txt"), text: "created" },
    ]);
    await expect(readFile(join(dir, "existing.txt"), "utf8")).resolves.toBe("new");
    await expect(readFile(join(dir, "added.txt"), "utf8")).resolves.toBe("created");
  });

  it("surfaces backend failure after a direct write may have changed the target", async () => {
    const dir = await makePlainTempDir();
    const path = join(dir, "file.txt");
    await writeFile(path, "old");
    const tool = createPatchTool("smart", "strict", {
      publicationBackend: {
        async replaceExisting(realTargetPath, completeText) {
          await writeFile(realTargetPath, completeText.slice(0, 1));
          throw new Error("simulated publication failure");
        },
        createNew: directTextFilePublicationBackend.createNew,
      },
    });

    const message = await rejectionMessage(tool.execute(
      "tool-call",
      { patch: ["*** Update File: file.txt", "@@", "-old", "+new"].join("\n") },
      undefined,
      undefined,
      { cwd: dir } as never,
    ));
    expect(message).toContain("[E_PARTIAL_PATCH]");
    expect(message).toContain("simulated publication failure");
    await expect(readFile(path, "utf8")).resolves.toBe("n");
  });
});

describe("edit visible status", () => {
  it.each([
    ["status update", async () => {
      const dir = await makePlainTempDir();
      await writeFile(join(dir, "file.txt"), "old\n");
      return smartPatchTool.execute(
        "tool-call",
        { patch: ["*** Update File: file.txt", "@@", "-old", "+new"].join("\n") },
        undefined,
        undefined,
        { cwd: dir } as never,
      );
    }],
    ["hash update", async () => {
      const dir = await makePlainTempDir();
      await writeFile(join(dir, "file.txt"), "old\n");
      return hashPatchTool.execute(
        "tool-call",
        { patch: ["*** Update File: file.txt", "@@", hashProfileRow("-", "old"), "+new"].join("\n"), receipt: "hash" },
        undefined,
        undefined,
        { cwd: dir } as never,
      );
    }],
    ["dry-run update", async () => {
      const dir = await makePlainTempDir();
      await writeFile(join(dir, "file.txt"), "old\n");
      return explicitPatchTool.execute(
        "tool-call",
        { patch: ["*** Update File: file.txt", "@@", "-:old", "+new"].join("\n"), dry_run: true },
        undefined,
        undefined,
        { cwd: dir } as never,
      );
    }],
    ["add", async () => {
      const dir = await makePlainTempDir();
      return explicitPatchTool.execute(
        "tool-call",
        { patch: ["*** Add File: added.txt", "+new"].join("\n") },
        undefined,
        undefined,
        { cwd: dir } as never,
      );
    }],
  ])("returns the built-in edit patch contract for %s", async (_label, makeResult) => {
    const result = await makeResult();
    const patch = detailsPatch(result);
    expect(patch).toMatch(/^--- file\.txt|^--- added\.txt/m);
    expect(patch).toMatch(/^\+\+\+ (?:file|added)\.txt/m);
    expect(patch).toMatch(/^@@ /m);
    expect(detailsDiff(result)).toBeTruthy();
  });

  it("warns in status receipts when tolerant anchor recovery is used", async () => {
    const dir = await makeExplicitTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "target");

    const result = await tolerantExplicitPatchTool.execute(
      "tool-call",
      { patch: ["*** Update File: file.txt", "@@ @3...3", "-:target"].join("\n") },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toBe([
      "*** Update File: file.txt",
      "Applied",
      "WARNING: Hunk 1 used tolerated outside match (authored anchor 3...3; resolved lines 1...1).",
    ].join("\n"));
    await expect(readFile(file, "utf8")).resolves.toBe("");
  });

  it("warns in hash receipts and dry runs when tolerant anchor recovery is used", async () => {
    const dir = await makeExplicitTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "target");
    const patch = ["*** Update File: file.txt", "@@ @3...3", "-:target"].join("\n");

    const hashResult = await tolerantExplicitPatchTool.execute(
      "tool-call",
      { patch, receipt: "hash" },
      undefined,
      undefined,
      { cwd: dir } as never,
    );
    expect(resultText(hashResult)).toContain("WARNING: Hunk 1 used tolerated outside match");

    await writeFile(file, "target");
    const dryRunResult = await tolerantExplicitPatchTool.execute(
      "tool-call",
      { patch, dry_run: true },
      undefined,
      undefined,
      { cwd: dir } as never,
    );
    expect(resultText(dryRunResult)).toContain("Validated");
    expect(resultText(dryRunResult)).toContain("WARNING: Hunk 1 used tolerated outside match");
    await expect(readFile(file, "utf8")).resolves.toBe("target");
  });

  it("keeps source-order resolution quiet while exposing bounded audit metadata", async () => {
    const patch = [
      "*** Update File: file.txt",
      "@@", "-:a", "-:x", "+first",
      "@@", "-:x", "-:b", "+second",
    ].join("\n");
    const statusDir = await makeExplicitTempDir();
    await writeFile(join(statusDir, "file.txt"), "a\nx\nb\na\nx\nb");
    const statusResult = await explicitPatchTool.execute(
      "tool-call", { patch }, undefined, undefined, { cwd: statusDir } as never,
    );
    const expectedOrderResolutions = [
      { groupStartHunk: 1, groupEndHunk: 2, selectedSpan: { startLine: 1, endLine: 2 } },
      { groupStartHunk: 1, groupEndHunk: 2, selectedSpan: { startLine: 5, endLine: 6 } },
    ];
    expect(resultText(statusResult)).toBe("*** Update File: file.txt\nApplied");
    expectNoSourceOrderWarning(resultText(statusResult));
    expect(detailsHunkAudits(statusResult).map((audit) => audit.orderResolution)).toEqual(expectedOrderResolutions);

    const hashDir = await makeExplicitTempDir();
    await writeFile(join(hashDir, "file.txt"), "a\nx\nb\na\nx\nb");
    const hashResult = await explicitPatchTool.execute(
      "tool-call", { patch, receipt: "hash" }, undefined, undefined, { cwd: hashDir } as never,
    );
    expectNoSourceOrderWarning(resultText(hashResult));
    expect(detailsHunkAudits(hashResult).map((audit) => audit.orderResolution)).toEqual(expectedOrderResolutions);

    const dryRunDir = await makeExplicitTempDir();
    const dryRunFile = join(dryRunDir, "file.txt");
    await writeFile(dryRunFile, "a\nx\nb\na\nx\nb");
    const dryRunResult = await explicitPatchTool.execute(
      "tool-call", { patch, dry_run: true }, undefined, undefined, { cwd: dryRunDir } as never,
    );
    expect(resultText(dryRunResult)).toBe("*** Update File: file.txt\nValidated");
    expectNoSourceOrderWarning(resultText(dryRunResult));
    expect(detailsHunkAudits(dryRunResult).map((audit) => audit.orderResolution)).toEqual(expectedOrderResolutions);
    await expect(readFile(dryRunFile, "utf8")).resolves.toBe("a\nx\nb\na\nx\nb");
  });

  it("keeps tolerated-boundary warnings unchanged when they order-resolve a following hunk", async () => {
    const dir = await makeExplicitTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "target\nmarker\ntarget");

    const result = await tolerantExplicitPatchTool.execute(
      "tool-call",
      {
        patch: [
          "*** Update File: file.txt",
          "@@ @3", "-:marker", "+moved",
          "@@", "-:target", "+selected",
        ].join("\n"),
      },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toBe([
      "*** Update File: file.txt",
      "Applied",
      "WARNING: Hunk 1 used tolerated outside match (authored anchor 3...EOF; resolved lines 2...2).",
    ].join("\n"));
    expect(detailsHunkAudits(result)[0]?.orderResolution).toBeUndefined();
    expect(detailsHunkAudits(result)[1]?.orderResolution).toEqual({
      groupStartHunk: 2,
      groupEndHunk: 2,
      selectedSpan: { startLine: 3, endLine: 3 },
    });
    await expect(readFile(file, "utf8")).resolves.toBe("target\nmoved\nselected");
  });

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
    expect(description).toContain("Do not include `*** Begin Patch` or `*** End Patch` boundaries.");
    expect(description).toContain("Line anchors are hard search boundaries, not proximity hints.");
    expect(description).toContain("They do not select the closest match.");
    expect(description).toContain("### Hunk Match: Smart Profile");
    expect(description).not.toContain('<example description="smart insertion">');
    expect(description).toContain('<bad_patch>\n-const operationTarget = await prepareOperationTarget(cwd, operation);\n+replacement\n</bad_patch>');
    expect(description).toContain('<patch>\n*** Update File: path/to/file.txt\n@@\n-operationTarget await\n+replacement\n</patch>');
    expect(description).toContain("sampled source-order tokens skip words between them");
    expect(description).toContain('<example description="character subsequence without spaces">');
    expect(description).toContain("long_object_name.long_function_call(long_arg_name)");
    expect(description).toContain("-longobj.longcall(arg)");
    expect(description).toContain("falls through to character subsequence");
    expect(description).not.toContain("<policy>");
    expect(description).not.toContain("markerless_selector");
  });

  it("keeps patch behavior policy in one prompt guideline chunk", () => {
    expect(smartPatchTool.promptGuidelines).toHaveLength(1);
    const guideline = smartPatchTool.promptGuidelines?.[0] ?? "";
    expect(smartPatchTool.promptSnippet).toBe("Use edit for line-based file changes. Use shorter selectors.");
    expect(smartPatchTool.promptSnippet).not.toContain("first attempt");

    expect(guideline).toContain("<edit_tool_policy>");
    expect(guideline).not.toContain("<patch_tool_policy>");
    expect(guideline).toContain("smallest set of short selectors");
    expect(guideline).toContain("add one neighboring short selector before lengthening");
    expect(guideline).toContain("Only lengthen a selector after a stale or ambiguous failure");
    expect(guideline).not.toContain("larger hunk with several neighboring short selectors");
    expect(guideline).not.toContain("Prefer short selectors plus accurate line anchors");
    expect(guideline).not.toContain("or an anchor hint");
    expect(guideline).not.toContain("safety margin");
    expect(guideline).not.toContain("upward line drift");
    expect(guideline).not.toContain("Wider margins may reintroduce ambiguity");
    expect(guideline).toContain("Use range selector whenever possible");
    expect(guideline).not.toContain("<important>");
    expect(guideline).toContain("</edit_tool_policy>");
  });

  it("is agent-visible as a hash receipt without selector cost metric", async () => {
    const diff = [
      "@@",
      row(" ", "a"),
      row("-", "old"),
      row("+", "new"),
      row(" ", "z"),
    ].join("\n");

    const { file, result } = await patchFile("a\nold\nz\n", diff);

    expect(smartPatchTool.name).toBe("edit");
    expect(resultText(result)).toBe(
      [
        "*** Update File: file.txt",
        "@@ matched line 1 @@",
        hashContext("a"),
        `+${hashLine("new")}`,
        hashContext("z"),
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
      ].join("\n"),
    );
    await expect(readFile(file, "utf8")).resolves.toBe("new");
  });

  it("supports literal replace rows in edit updates", async () => {
    const dir = await makePlainTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "const timeoutMs = 5000;\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      " timeoutMs",
      "/5000",
      "=3000",
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
      ].join("\n"),
    );
    expect(detailsDiff(result)).toContain("-const timeoutMs = 5000;");
    expect(detailsDiff(result)).toContain("+const timeoutMs = 3000;");
    expect(detailsPatchSize(result)).toEqual({
      patchChars: 81,
      unifiedDiffChars: 108,
    });
    await expect(readFile(file, "utf8")).resolves.toBe("const timeoutMs = 3000;\n");
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
    await writeProfileSettings(agentDir, "hash");
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
      ].join("\n"),
    );
    await expect(readFile(file, "utf8")).resolves.toBe(
      "anchor line\nnew value",
    );
  });

  it("does not allow per-call row-parsing override in hash profile", async () => {
    const dir = await makePlainTempDir();
    const agentDir = join(dir, "agent");
    await writeProfileSettings(agentDir, "hash");
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
    await writeProfileSettings(agentDir, "hash");
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
      ].join("\n"),
    );
    await expect(readFile(file, "utf8")).resolves.toBe("new");
  });

  it("keeps smart unified-diff rows in retry patches for configured smart defaults", async () => {
    const dir = await makePlainTempDir();
    const agentDir = join(dir, "agent");
    await writeProfileSettings(agentDir, "smart");
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
  it("reports full normalized patch size against unified-diff size", async () => {
    const universal = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      "-^old",
      "+new",
      "*** End Patch",
    ].join("\n");

    const { result } = await patchFile("old text", universal);

    expect(detailsPatchSize(result)).toEqual({
      patchChars: 69,
      unifiedDiffChars: 73,
    });
    expect(detailsSelectorEfficiency(result)).toEqual({
      patchChars: 5,
      baselineChars: 9,
    });
  });
  it("counts full framing and treats a physically blank context row as canonical unified diff", async () => {
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

    expect(detailsPatchSize(combinedResult)).toEqual({
      patchChars: 83,
      unifiedDiffChars: 73,
    });
    expect(detailsPatchSize(blankContextResult)).toEqual({
      patchChars: 69,
      unifiedDiffChars: 69,
    });
  });
  it("reports full patch size for add, range, and dry-run changes", async () => {
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

    expect(detailsPatchSize(addResult)).toEqual({
      patchChars: 67,
      unifiedDiffChars: 67,
    });
    expect(detailsPatchSize(rangeResult)).toEqual({
      patchChars: 70,
      unifiedDiffChars: 71,
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

  it("leaves a file unchanged when a resolved Update section also contains a stale hunk", async () => {
    const dir = await makePlainTempDir();
    const file = join(dir, "a.txt");
    await writeFile(file, "target\nboundary\ntarget");
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-:target",
      "+first",
      "+inserted",
      "@@",
      "-:boundary",
      "+done",
      "@@",
      "-:missing",
      "+never",
      "*** End Patch",
    ].join("\n");

    await expect(
      smartPatchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never),
    ).rejects.toThrow("[E_STALE_HUNK]");
    await expect(readFile(file, "utf8")).resolves.toBe("target\nboundary\ntarget");
  });

  it("keeps a complete Update section atomic when candidate discovery exhausts", async () => {
    const dir = await makePlainTempDir();
    const file = join(dir, "a.txt");
    const candidate = "candidate text that must not appear in diagnostics";
    await writeFile(file, ["header", ...Array.from({ length: 1_001 }, () => candidate)].join("\n"));
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " header",
      "+marker",
      "@@",
      `-${candidate}`,
      "+replacement",
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      smartPatchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never),
    );

    expect(message).toContain("[E_PARTIAL_PATCH]");
    expect(message).toContain("[E_HUNK_CANDIDATE_LIMIT] Line 7:");
    expect(message).toContain("discovered 1001+");
    expect(message).not.toContain(candidate);
    await expect(readFile(file, "utf8")).resolves.toBe(
      ["header", ...Array.from({ length: 1_001 }, () => candidate)].join("\n"),
    );
  });

  it("bounds applied and skipped operation headers in partial-patch diagnostics", async () => {
    const dir = await makePlainTempDir();
    await writeFile(join(dir, "a.txt"), "present");
    const selector = "missing selector text that must not appear in diagnostics";
    const appliedOperations = Array.from({ length: 5 }, (_value, index) => [
      `*** Add File: applied-${index}.txt`,
      "+applied",
    ]).flat();
    const skippedOperations = Array.from({ length: 5 }, (_value, index) => [
      `*** Add File: skipped-${index}.txt`,
      "+skipped",
    ]).flat();
    const patch = [
      "*** Begin Patch",
      ...appliedOperations,
      "*** Update File: a.txt",
      "@@",
      `-${selector}`,
      "+replacement",
      ...skippedOperations,
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      smartPatchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never),
    );

    expect(message).toContain("*** Add File: applied-0.txt");
    expect(message).toContain("*** Add File: applied-3.txt");
    expect(message).toContain("... 1 applied operation omitted.");
    expect(message).not.toContain("*** Add File: applied-4.txt");
    expect(message).toContain("*** Add File: skipped-0.txt");
    expect(message).toContain("*** Add File: skipped-3.txt");
    expect(message).toContain("... 1 skipped operation omitted.");
    expect(message).not.toContain("*** Add File: skipped-4.txt");
    expect(message).not.toContain(selector);
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toContain(
      "*** Add File: skipped-4.txt",
    );
  });

  it("bounds tolerated-match warnings in partial-patch diagnostics", async () => {
    const dir = await makeExplicitTempDir();
    const file = join(dir, "a.txt");
    const warningCount = 1_001;
    await writeFile(
      file,
      Array.from({ length: warningCount }, (_value, index) => `target-${index}`).join("\n"),
    );
    const updateHunks = Array.from({ length: warningCount }, (_value, index) => [
      `@@ @${warningCount + 1}...${warningCount + 1}`,
      ` :target-${index}`,
    ].join("\n"));
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      ...updateHunks,
      "*** Add File: missing-parent/failure.txt",
      "+failure",
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      tolerantExplicitPatchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never),
    );

    expect(message).toContain("WARNING: Hunk 1 used tolerated outside match");
    expect(message).toContain(`... ${warningCount - 4} tolerated match warnings omitted.`);
    expect(message).not.toContain("WARNING: Hunk 5 used tolerated outside match");
    expect(getVisibleOutputOverflow(message)).toBeUndefined();
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toContain(
      "*** Add File: missing-parent/failure.txt",
    );
  });

  it("bounds long raw operation paths in partial-patch diagnostics", async () => {
    const dir = await makePlainTempDir();
    const normalizedSafePath = (leaf: string) => `${"x/../".repeat(12_000)}${leaf}`;
    const failedPath = normalizedSafePath("missing-parent/failure.txt");
    const skippedPath = normalizedSafePath("skipped.txt");
    const retryPatch = [
      "*** Begin Patch",
      `*** Add File: ${failedPath}`,
      "+failure",
      `*** Add File: ${skippedPath}`,
      "+skipped",
      "*** End Patch",
    ].join("\n");

    const message = await rejectionMessage(
      smartPatchTool.execute("tool-call", { patch: retryPatch }, undefined, undefined, { cwd: dir } as never),
    );

    expect(getVisibleOutputOverflow(message)).toBeUndefined();
    expect(message).toContain("partial-patch diagnostic truncated");
    expect(message).not.toContain(failedPath);
    await expect(readFile(retryPatchPathFrom(message), "utf8")).resolves.toBe(retryPatch);
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

  it("keeps partial-operation summaries quiet after source-order resolution", async () => {
    const dir = await makeExplicitTempDir();
    const file = join(dir, "one.txt");
    await writeFile(file, "a\nx\nb\na\nx\nb");
    const patch = [
      "*** Update File: one.txt",
      "@@", "-:a", "-:x", "+first",
      "@@", "-:x", "-:b", "+second",
      "*** Add File: missing-parent/two.txt",
      "+second",
    ].join("\n");

    const message = await rejectionMessage(
      explicitPatchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never),
    );

    expect(message).toContain("Applied:\n*** Update File: one.txt");
    expectNoSourceOrderWarning(message);
    await expect(readFile(file, "utf8")).resolves.toBe("first\nb\na\nsecond");
  });

  it("keeps tolerated-match warnings in partial-patch failures", async () => {
    const dir = await makeExplicitTempDir();
    await writeFile(join(dir, "one.txt"), "target");
    const patch = [
      "*** Update File: one.txt",
      "@@ @3...3",
      "-:target",
      "*** Add File: missing-parent/two.txt",
      "+second",
    ].join("\n");

    const message = await rejectionMessage(
      tolerantExplicitPatchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never),
    );

    expect(message).toContain("Applied:\n*** Update File: one.txt\nWARNING: Hunk 1 used tolerated outside match");
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

  it("accepts a trailing closing boundary without an opening boundary", async () => {
    const dir = await makePlainTempDir();
    await writeFile(join(dir, "a.txt"), "old\n");
    const patch = [
      "*** Update File: a.txt",
      "@@",
      "-old",
      "+replacement",
      "*** End Patch",
    ].join("\n");

    const result = await smartPatchTool.execute("tool-call", { patch }, undefined, undefined, {
      cwd: dir,
    } as never);

    expect(resultText(result)).toContain("Applied");
    await expect(readFile(join(dir, "a.txt"), "utf8")).resolves.toBe("replacement\n");
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

  it("leaves a file unchanged when conflicting hunks reject its update section", async () => {
    const dir = await makeExplicitTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "start\nmiddle\nend");
    const patch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      " :start",
      " ...",
      " :end",
      "+after-end",
      "@@",
      " :middle",
      "+after-middle",
      "*** End Patch",
    ].join("\n");

    await expect(
      explicitPatchTool.execute("tool-call", { patch }, undefined, undefined, { cwd: dir } as never),
    ).rejects.toThrow("[E_CONFLICTING_HUNKS]");
    await expect(readFile(file, "utf8")).resolves.toBe("start\nmiddle\nend");
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
      ].join("\n"),
    );
    expect(resultText(result)).not.toContain("line-1");
    await expect(readFile(file, "utf8")).resolves.toBe(manyLines.join("\n"));
  });

  it("keeps compact receipt fallback quiet after source-order resolution", async () => {
    const dir = await makeExplicitTempDir();
    const file = join(dir, "file.txt");
    const inserted = Array.from({ length: 2100 }, (_, index) => `+line-${index}`);
    await writeFile(file, "a\nx\nb\na\nx\nb");

    const result = await explicitPatchTool.execute(
      "tool-call",
      {
        patch: [
          "*** Update File: file.txt",
          "@@", "-:a", "-:x", ...inserted,
          "@@", "-:x", "-:b", "+second",
        ].join("\n"),
        receipt: "hash",
      },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    expect(resultText(result)).toBe("*** Update File: file.txt\nApplied");
    expectNoSourceOrderWarning(resultText(result));
    expect(detailsHunkAudits(result).map((audit) => audit.orderResolution)).toEqual([
      { groupStartHunk: 1, groupEndHunk: 2, selectedSpan: { startLine: 1, endLine: 2 } },
      { groupStartHunk: 1, groupEndHunk: 2, selectedSpan: { startLine: 5, endLine: 6 } },
    ]);
    expect((result.details as { status: { omitReason?: string } }).status.omitReason).toBe("too_large");
  });

  it("keeps tolerated-match warnings when a hash receipt falls back to status", async () => {
    const dir = await makeExplicitTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "target");
    const inserted = Array.from({ length: 2100 }, (_, index) => `+line-${index}`);
    const patch = ["*** Update File: file.txt", "@@ @3...3", "-:target", ...inserted].join("\n");

    const result = await tolerantExplicitPatchTool.execute(
      "tool-call",
      { patch, receipt: "hash" },
      undefined,
      undefined,
      { cwd: dir } as never,
    );

    const warning = "WARNING: Hunk 1 used tolerated outside match";
    expect(resultText(result)).toContain(warning);
    expect(resultText(result).split(warning)).toHaveLength(2);
  });

  it("omits empty statuses", async () => {
    const diff = ["@@", row("-", "only")].join("\n");

    const { file, result } = await patchFile("only", diff);

    expect(resultText(result)).toBe(
      [
        "*** Update File: file.txt",
        "@@ matched line 1 @@",
      ].join("\n"),
    );
    await expect(readFile(file, "utf8")).resolves.toBe("");
  });
});
