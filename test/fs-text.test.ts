import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileTextError, hashLine, readExistingTextFile, writeTextFileAtomically } from "../src/api.js";
import { patchTool } from "../src/tools/locator-patch.js";

const makeTempDir = () => mkdtemp(join(tmpdir(), "pi-locator-patch-"));
const row = (prefix: "=" | "-" | "+", content: string) => prefix === "+" ? `${prefix}${content}` : `${prefix}#${hashLine(content)}`;

describe("text file IO", () => {
  it("rejects invalid UTF-8, NUL bytes, and directories", async () => {
    const dir = await makeTempDir();
    const invalid = join(dir, "invalid.txt");
    const nul = join(dir, "nul.txt");
    await writeFile(invalid, Buffer.from([0xff]));
    await writeFile(nul, Buffer.from("a\0b"));

    await expect(readExistingTextFile(invalid)).rejects.toThrow(FileTextError);
    await expect(readExistingTextFile(nul)).rejects.toThrow(FileTextError);
    await expect(readExistingTextFile(dir)).rejects.toThrow(FileTextError);
  });

  it("preserves UTF-8 BOM on read", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "bom.txt");
    await writeFile(file, Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    await expect(readExistingTextFile(file)).resolves.toMatchObject({ text: "\uFEFFa" });
  });

  it("atomically writes through symlinks to update target content", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    await writeFile(target, "old");
    await symlink(target, link);

    await writeTextFileAtomically(link, "new");
    await expect(readFile(target, "utf8")).resolves.toBe("new");
  });
});

describe("patch tool", () => {
  it("dry_run validates and returns status without writing", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "old");
    const diff = ["*** Begin Patch", "*** Update File: file.txt", "@@", row("-", "old"), row("+", "new"), "*** End Patch"].join("\n");

    const result = await patchTool.execute("tool-call", { patch: diff, dry_run: true }, undefined, undefined, { cwd: dir } as never);

    const content = result.content[0];
    expect(content.type).toBe("text");
    if (content.type !== "text") {
      throw new Error("Expected text content");
    }
    expect(content.text).toBe(["*** Update File: file.txt", "Validated"].join("\n"));
    await expect(readFile(file, "utf8")).resolves.toBe("old");
  });

  it("leaves file unchanged when patch is stale", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "actual");
    const diff = ["*** Begin Patch", "*** Update File: file.txt", "@@", row("-", "old"), row("+", "new"), "*** End Patch"].join("\n");

    await expect(
      patchTool.execute("tool-call", { patch: diff }, undefined, undefined, { cwd: dir } as never)
    ).rejects.toThrow("[E_STALE_HUNK]");
    await expect(readFile(file, "utf8")).resolves.toBe("actual");
  });
});
