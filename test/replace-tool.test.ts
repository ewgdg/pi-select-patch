import { chmod, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  directTextFilePublicationBackend,
  type TextFilePublicationBackend,
} from "../src/text-file-publication.js";
import { createReplaceTool } from "../src/tools/replace.js";

const createTempDirectory = () => mkdtemp(join(tmpdir(), "pi-select-patch-replace-"));

function createReplaceToolWithPublisher(
  replaceExisting: TextFilePublicationBackend["replaceExisting"],
) {
  return createReplaceTool({
    publicationBackend: {
      ...directTextFilePublicationBackend,
      replaceExisting,
    },
  });
}

async function executeReplace(
  cwd: string,
  params: {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  },
  signal?: AbortSignal,
  tool = createReplaceTool(),
) {
  return tool.execute("tool-call", params, signal, undefined, { cwd } as never);
}

function resultText(result: Awaited<ReturnType<typeof executeReplace>>): string {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected text result");
  return content.text;
}

describe("replace tool contract", () => {
  it("exposes the exact model-facing schema and metadata", () => {
    const tool = createReplaceTool();
    const schema = tool.parameters as {
      additionalProperties?: boolean;
      required?: string[];
      properties: Record<string, { description?: string; default?: unknown }>;
    };

    expect(tool.name).toBe("replace");
    expect(tool.description).toBe("Replace exact literal text in one file.");
    expect(tool.promptSnippet).toBe("Replace exact literal text in one file.");
    expect(Object.keys(schema.properties)).toEqual([
      "file_path",
      "old_string",
      "new_string",
      "replace_all",
    ]);
    expect(schema.required).toEqual(["file_path", "old_string", "new_string"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.file_path?.description).toBe("Path to the file to modify.");
    expect(schema.properties.old_string?.description).toBe("Exact text to replace.");
    expect(schema.properties.new_string?.description).toBe("Replacement text.");
    expect(schema.properties.replace_all?.description).toBe(
      "Replace all occurrences instead of requiring a unique match.",
    );
    expect(schema.properties.replace_all?.default).toBe(false);

    expect(Check(tool.parameters, {
      file_path: "file.txt",
      old_string: "old",
      new_string: "new",
    })).toBe(true);
    expect(Check(tool.parameters, {
      file_path: "file.txt",
      old_string: "old",
      new_string: "new",
      replace_all: false,
    })).toBe(true);
    expect(Check(tool.parameters, {
      path: "file.txt",
      oldText: "old",
      newText: "new",
    })).toBe(false);
    expect(Check(tool.parameters, {
      file_path: "file.txt",
      old_string: "old",
      new_string: "new",
      extra: true,
    })).toBe(false);
  });

  it("replaces one unique literal and returns only the compact receipt and audit details", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), "before old after\n");

    const result = await executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "old",
      new_string: "new",
    });

    expect(resultText(result)).toBe("Replaced 1 occurrence.");
    expect(result.details).toMatchObject({ occurrenceCount: 1 });
    expect(Object.keys(result.details as object).sort()).toEqual(["diff", "occurrenceCount"]);
    expect((result.details as { diff: string }).diff).toContain("--- file.txt\n+++ file.txt");
    expect((result.details as { diff: string }).diff).not.toContain(cwd);
    await expect(readFile(join(cwd, "file.txt"), "utf8")).resolves.toBe("before new after\n");
  });

  it("supports unique multiline replacement with canonicalized input newlines", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), "start\n  one\n  two\nend\n");

    await executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "  one\r\n  two",
      new_string: "  first\r  second",
    });

    await expect(readFile(join(cwd, "file.txt"), "utf8")).resolves.toBe(
      "start\n  first\n  second\nend\n",
    );
  });

  it("treats omission and explicit false for replace_all identically", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "omitted.txt"), "old old");
    await writeFile(join(cwd, "false.txt"), "old old");

    await expect(executeReplace(cwd, {
      file_path: "omitted.txt",
      old_string: "old",
      new_string: "new",
    })).rejects.toThrow("[E_REPLACE_AMBIGUOUS]");
    await expect(executeReplace(cwd, {
      file_path: "false.txt",
      old_string: "old",
      new_string: "new",
      replace_all: false,
    })).rejects.toThrow("[E_REPLACE_AMBIGUOUS]");
    await expect(readFile(join(cwd, "omitted.txt"), "utf8")).resolves.toBe("old old");
    await expect(readFile(join(cwd, "false.txt"), "utf8")).resolves.toBe("old old");
  });
});

describe("replace occurrence semantics", () => {
  it("reports zero occurrences and asks for a reread", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), "actual");

    await expect(executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "missing",
      new_string: "new",
    })).rejects.toThrow(
      "[E_REPLACE_NOT_FOUND] Found 0 occurrences. Reread the file before retrying.",
    );
  });

  it("reports the non-overlapping ambiguity count and safe recovery choices", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), "old old old");

    await expect(executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "old",
      new_string: "new",
    })).rejects.toThrow(
      "[E_REPLACE_AMBIGUOUS] Found 3 occurrences. Include more unchanged context or set replace_all to true.",
    );
  });

  it("replaces every original non-overlapping occurrence without rescanning inserted text", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), "aa");

    const result = await executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "a",
      new_string: "aa",
      replace_all: true,
    });

    expect(resultText(result)).toBe("Replaced 2 occurrences.");
    expect(result.details).toMatchObject({ occurrenceCount: 2 });
    await expect(readFile(join(cwd, "file.txt"), "utf8")).resolves.toBe("aaaa");
  });

  it("counts self-overlapping candidates left-to-right after the full match", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), "aaaaa");

    const result = await executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "aaa",
      new_string: "X",
      replace_all: true,
    });

    expect(resultText(result)).toBe("Replaced 1 occurrence.");
    await expect(readFile(join(cwd, "file.txt"), "utf8")).resolves.toBe("Xaa");
  });

  it.each([
    ["case-sensitive", "Alpha", "alpha", "x"],
    ["whitespace-preserving", "old", " old ", "x"],
    ["no-dedent", "  one\n  two", "one\ntwo", "x"],
    ["no-fuzzy", "colour", "color", "x"],
    ["no-unicode-normalization", "é", "e\u0301", "x"],
  ])("keeps matching %s", async (_label, fileText, oldString, newString) => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), fileText);

    await expect(executeReplace(cwd, {
      file_path: "file.txt",
      old_string: oldString,
      new_string: newString,
    })).rejects.toThrow("[E_REPLACE_NOT_FOUND]");
    await expect(readFile(join(cwd, "file.txt"), "utf8")).resolves.toBe(fileText);
  });
});

describe("replace semantic validation", () => {
  it.each([
    ["empty old_string", "", "new", "old_string must not be empty"],
    ["canonicalized no-op", "a\r\nb", "a\nb", "old_string and new_string must differ after newline canonicalization"],
    ["NUL old_string", "a\0b", "new", "old_string must not contain NUL characters"],
    ["NUL new_string", "old", "a\0b", "new_string must not contain NUL characters"],
    ["unpaired high surrogate", "\uD800", "new", "old_string must contain valid Unicode"],
    ["unpaired low surrogate", "old", "\uDC00", "new_string must contain valid Unicode"],
  ])("rejects %s before filesystem access", async (_label, oldString, newString, message) => {
    const cwd = await createTempDirectory();

    await expect(executeReplace(cwd, {
      file_path: "missing.txt",
      old_string: oldString,
      new_string: newString,
    })).rejects.toThrow(`[E_INVALID_REPLACE] ${message}.`);
  });

  it("permits deletion, including deleting the complete searchable body while preserving BOM", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), "\uFEFFcomplete body");

    await executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "complete body",
      new_string: "",
    });

    await expect(readFile(join(cwd, "file.txt"), "utf8")).resolves.toBe("\uFEFF");
  });

  it("keeps semantic errors independent of paths and replacement contents", async () => {
    const cwd = await createTempDirectory();
    const secret = "do-not-echo-this-secret";

    let error: unknown;
    try {
      await executeReplace(cwd, {
        file_path: "private/missing.txt",
        old_string: `${secret}\0`,
        new_string: "new",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("[E_INVALID_REPLACE]");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("private/missing.txt");
  });
});

describe("replace newline and BOM behavior", () => {
  it("keeps the BOM outside matching and restores it after replacement", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), "\uFEFFold\n");

    await expect(executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "\uFEFFold",
      new_string: "new",
    })).rejects.toThrow("[E_REPLACE_NOT_FOUND]");

    await executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "old",
      new_string: "new",
    });
    await expect(readFile(join(cwd, "file.txt"), "utf8")).resolves.toBe("\uFEFFnew\n");
  });

  it("uses CRLF when the first encountered newline is CRLF and normalizes the whole result", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), "a\r\nb\nc\rd");

    await executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "b\r\nc\rd",
      new_string: "x\ny",
    });

    await expect(readFile(join(cwd, "file.txt"), "utf8")).resolves.toBe("a\r\nx\r\ny");
  });

  it("uses LF for LF, standalone-CR-first, and newline-free files", async () => {
    const cwd = await createTempDirectory();
    const cases = [
      { name: "lf.txt", initial: "a\nb", old: "a\nb", next: "x\ny", expected: "x\ny" },
      { name: "cr.txt", initial: "a\rb\nc", old: "a\nb\nc", next: "x\ny", expected: "x\ny" },
      { name: "none.txt", initial: "ab", old: "ab", next: "a\nb", expected: "a\nb" },
    ];

    for (const testCase of cases) {
      await writeFile(join(cwd, testCase.name), testCase.initial);
      await executeReplace(cwd, {
        file_path: testCase.name,
        old_string: testCase.old,
        new_string: testCase.next,
      });
      await expect(readFile(join(cwd, testCase.name), "utf8")).resolves.toBe(testCase.expected);
    }
  });

  it("treats the terminal newline as searchable content", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "remove.txt"), "a\n");
    await writeFile(join(cwd, "add.txt"), "a");

    await executeReplace(cwd, {
      file_path: "remove.txt",
      old_string: "\n",
      new_string: "",
    });
    await executeReplace(cwd, {
      file_path: "add.txt",
      old_string: "a",
      new_string: "a\n",
    });

    await expect(readFile(join(cwd, "remove.txt"), "utf8")).resolves.toBe("a");
    await expect(readFile(join(cwd, "add.txt"), "utf8")).resolves.toBe("a\n");
  });
});

describe("replace target and publication failures", () => {
  it.each([
    ["missing target", "missing.txt", undefined, "File not found"],
    ["directory target", "directory", "directory", "not a regular text file"],
    ["NUL-containing target", "nul.txt", Buffer.from("a\0b"), "contains NUL bytes"],
    ["invalid UTF-8 target", "invalid.txt", Buffer.from([0xff]), "Invalid UTF-8"],
  ])("distinguishes %s with E_FILE_TEXT", async (_label, path, contents, message) => {
    const cwd = await createTempDirectory();
    if (contents === "directory") {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(cwd, path)));
    } else if (contents !== undefined) {
      await writeFile(join(cwd, path), contents);
    }

    await expect(executeReplace(cwd, {
      file_path: path,
      old_string: "old",
      new_string: "new",
    })).rejects.toThrow(`[E_FILE_TEXT]`);
    await expect(executeReplace(cwd, {
      file_path: path,
      old_string: "old",
      new_string: "new",
    })).rejects.toThrow(message);
  });

  it.runIf(process.getuid?.() !== 0)("distinguishes an inaccessible target", async () => {
    const cwd = await createTempDirectory();
    const path = join(cwd, "locked.txt");
    await writeFile(path, "old");
    await chmod(path, 0o000);
    try {
      await expect(executeReplace(cwd, {
        file_path: "locked.txt",
        old_string: "old",
        new_string: "new",
      })).rejects.toThrow("[E_FILE_TEXT] File is not readable and writable");
    } finally {
      await chmod(path, 0o600);
    }
  });

  it("does not misreport other path-resolution failures as missing files", async () => {
    const cwd = await createTempDirectory();
    await symlink("loop-b", join(cwd, "loop-a"));
    await symlink("loop-a", join(cwd, "loop-b"));

    await expect(executeReplace(cwd, {
      file_path: "loop-a",
      old_string: "old",
      new_string: "new",
    })).rejects.toThrow("[E_FILE_TEXT] Could not resolve text file: loop-a (ELOOP)");
  });

  it("bounds and single-lines caller paths in file errors", async () => {
    const cwd = await createTempDirectory();
    const filePath = `missing\n${"x".repeat(500)}`;

    let error: unknown;
    try {
      await executeReplace(cwd, {
        file_path: filePath,
        old_string: "old",
        new_string: "new",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("[E_FILE_TEXT] Could not resolve text file: missing\\n");
    expect(message).toContain("(ENAMETOOLONG)");
    expect(message).toContain("chars omitted");
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThan(400);
  });

  it("normalizes a leading at-sign in the caller path", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), "old");

    const result = await executeReplace(cwd, {
      file_path: "@file.txt",
      old_string: "old",
      new_string: "new",
    });

    expect((result.details as { diff: string }).diff).toContain("--- @file.txt\n+++ @file.txt");
    await expect(readFile(join(cwd, "file.txt"), "utf8")).resolves.toBe("new");
  });

  it("warns that direct-write failure may leave partial content and returns no result details", async () => {
    const cwd = await createTempDirectory();
    const path = join(cwd, "file.txt");
    await writeFile(path, "old");
    const tool = createReplaceToolWithPublisher(async (realTargetPath, text) => {
      await writeFile(realTargetPath, text.slice(0, 1));
      throw new Error("simulated write failure\nextra diagnostics");
    });

    await expect(executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "old",
      new_string: "new",
    }, undefined, tool)).rejects.toThrow(
      "[E_REPLACE_WRITE] simulated write failure. The file may be partially written or truncated. Reread it before retrying.",
    );
    await expect(readFile(path, "utf8")).resolves.toBe("n");
  });

  it("never creates a retry artifact after a failed replacement", async () => {
    const cwd = await createTempDirectory();
    await writeFile(join(cwd, "file.txt"), "old old");
    const entriesBefore = await readdir(cwd);

    await expect(executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "old",
      new_string: "new",
    })).rejects.toThrow("[E_REPLACE_AMBIGUOUS]");

    expect(await readdir(cwd)).toEqual(entriesBefore);
  });
});

describe("replace cancellation and mutation queue", () => {
  it("checks cancellation before filesystem work", async () => {
    const cwd = await createTempDirectory();
    const controller = new AbortController();
    controller.abort();
    let published = false;
    const tool = createReplaceToolWithPublisher(async () => {
      published = true;
    });

    await expect(executeReplace(cwd, {
      file_path: "missing.txt",
      old_string: "old",
      new_string: "new",
    }, controller.signal, tool)).rejects.toThrow("Cancelled");
    expect(published).toBe(false);
  });

  it("checks cancellation after waiting for the file queue and before publication", async () => {
    const cwd = await createTempDirectory();
    const path = join(cwd, "file.txt");
    await writeFile(path, "old");
    const realTargetPath = await realpath(path);
    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    let queueHeld!: () => void;
    const queueAcquired = new Promise<void>((resolve) => { queueHeld = resolve; });
    const blocker = withFileMutationQueue(realTargetPath, async () => {
      queueHeld();
      await queueGate;
    });
    await queueAcquired;

    let published = false;
    const tool = createReplaceToolWithPublisher(async () => {
      published = true;
    });
    const controller = new AbortController();
    const execution = executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "old",
      new_string: "new",
    }, controller.signal, tool);
    controller.abort();
    releaseQueue();
    await blocker;

    await expect(execution).rejects.toThrow("Cancelled");
    expect(published).toBe(false);
    await expect(readFile(path, "utf8")).resolves.toBe("old");
  });

  it("checks cancellation after planning and immediately before publication", async () => {
    const cwd = await createTempDirectory();
    const path = join(cwd, "file.txt");
    await writeFile(path, "old");
    const controller = new AbortController();
    let published = false;
    const tool = createReplaceToolWithPublisher(async () => {
      published = true;
    });

    const execution = tool.execute(
      "tool-call",
      { file_path: "file.txt", old_string: "old", new_string: "new" },
      controller.signal,
      () => controller.abort(),
      { cwd } as never,
    );

    await expect(execution).rejects.toThrow("Cancelled");
    expect(published).toBe(false);
    await expect(readFile(path, "utf8")).resolves.toBe("old");
  });

  it("reports success when cancellation arrives during a confirmed successful publication", async () => {
    const cwd = await createTempDirectory();
    const path = join(cwd, "file.txt");
    await writeFile(path, "old");
    let publicationStarted!: () => void;
    const started = new Promise<void>((resolve) => { publicationStarted = resolve; });
    let finishPublication!: () => void;
    const finish = new Promise<void>((resolve) => { finishPublication = resolve; });
    const tool = createReplaceToolWithPublisher(async (realTargetPath, text) => {
      publicationStarted();
      await finish;
      await writeFile(realTargetPath, text);
    });
    const controller = new AbortController();
    const execution = executeReplace(cwd, {
      file_path: "file.txt",
      old_string: "old",
      new_string: "new",
    }, controller.signal, tool);

    await started;
    controller.abort();
    finishPublication();

    await expect(execution).resolves.toMatchObject({
      content: [{ type: "text", text: "Replaced 1 occurrence." }],
    });
    await expect(readFile(path, "utf8")).resolves.toBe("new");
  });

  it("serializes the full mutation window across symlink aliases and keeps the queue during publication", async () => {
    const cwd = await createTempDirectory();
    const target = join(cwd, "target.txt");
    const alias = join(cwd, "alias.txt");
    await writeFile(target, "a");
    await symlink(target, alias);

    let firstPublicationStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstPublicationStarted = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let publicationCount = 0;
    const tool = createReplaceToolWithPublisher(async (realTargetPath, text) => {
      publicationCount += 1;
      if (publicationCount === 1) {
        firstPublicationStarted();
        await firstGate;
      }
      await writeFile(realTargetPath, text);
    });

    const first = executeReplace(cwd, {
      file_path: "target.txt",
      old_string: "a",
      new_string: "b",
    }, undefined, tool);
    await firstStarted;
    const second = executeReplace(cwd, {
      file_path: "alias.txt",
      old_string: "b",
      new_string: "c",
    }, undefined, tool);
    await new Promise((resolve) => setImmediate(resolve));
    expect(publicationCount).toBe(1);

    releaseFirst();
    await first;
    await second;

    expect(publicationCount).toBe(2);
    await expect(readFile(target, "utf8")).resolves.toBe("c");
  });
});
